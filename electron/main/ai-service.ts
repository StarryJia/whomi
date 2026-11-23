import { defaultPrompts } from '../../src/shared/system-prompts'
import type { AnalysisContext } from '../data/ai/repository'
import { acceptedThinking, reasoningCapabilities } from '../agent/reasoning-capabilities'
import type { ThinkingLevel } from '../../src/shared/thinking'
import { createHash, randomUUID } from 'node:crypto'
import type { AiEvent, AiMethods, AiModel, AiThread, AiTurn, AiUsage, AnalysisTask } from '../../src/shared/ai-contract'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { resolveModelLimits } from '../../src/shared/model-limits'
import { createMessageProcessor, type ProcessingMember, type ProcessingMessage } from './message-processing'
import type { ProcessingSettings } from '../../src/shared/settings-contract'
import type { InsightReport, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { generateInsight } from './insight-generation'
import { defaultInsightPrompts, INSIGHT_PROMPT_VERSION, type InsightPrompts } from '../data/ai/insight-prompts'
import { InsightBudgetError, type InsightCheckpoint } from './insight-checkpoint'
import { defaultInsightRunLimits } from './insight-policy'
import { diagnosticErrorCode, type AppError } from './app-error-logs'
import { aiOperation, runDiagnosedModel, type AiDiagnostics, type AiOperation, type ModelRetry } from './ai-operation-diagnostics'

type SourceMessage = ProcessingMessage & { isSelf: boolean }
type TurnContext = { systemPrompt?: string; turn: AiTurn; conversationId: string; model: AiModel; selfFingerprint: string; references: SourceMessage[]; history: { role: 'user' | 'assistant'; text: string; references?: SourceMessage[] }[]; profile: InsightReport | null; skill: { id: string; version: string; content: string } | null; checkpoint: string | null }
export type RuntimeInput = { purpose?: 'insight'; thinkingLevel?: ThinkingLevel; key: string; model: AiModel; apiKey?: string; systemPrompt: string; prompt: string; history?: { role: 'user' | 'assistant'; text: string }[]; checkpoint?: string | null; outputTokenLimit?: number }
export type RuntimeResult = { stopReason?: 'length'; text: string; usage: AiUsage; checkpoint: string }
export type RuntimeRunner = { run(input: RuntimeInput, options: { signal: AbortSignal; onText: (text: string) => void }): Promise<RuntimeResult> }
export type AiServiceOptions = { storage(method: string, args: unknown[]): Promise<unknown>; runtime: RuntimeRunner; secrets: { encrypt(value: string): string; decrypt(value: string): string }; changed?: (event: AiEvent) => void;
  logError?: (entry: AppError) => void;
  diagnostics?: AiDiagnostics;
  processing?: (conversationId: string) => Promise<{ settings: ProcessingSettings; members: ProcessingMember[] }>;
  claimProcessing?: (taskId: string, signature: string) => Promise<void> }
const dialogueSystem = defaultPrompts.dialogue
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function assertInputFits(input: RuntimeInput) {
  const room = resolveModelLimits(input.model).maxInputTokens - 1000 - Buffer.byteLength(input.systemPrompt) - Buffer.byteLength(JSON.stringify(input.history ?? []))
  if (Buffer.byteLength(input.prompt) > room) throw new BoundaryError('CONTEXT_TOO_LARGE', '当前内容超出最大输入长度，请减少内容或选择更大上下文的模型。')
}


export function createAiService(options: AiServiceOptions): AiMethods & { deleteConversation(id: string, remove: () => Promise<void>): Promise<void>; hasModelWork(ids: string[]): boolean; isBusy(): boolean; stopModelTasks(ids: string[]): Promise<void>; idle(): Promise<void>; close(): Promise<void>; subscribe(listener: (event: AiEvent) => void): () => void } {
  type Work = { key: string; conversationId: string; modelId?: string; abort: AbortController; task: Promise<void> }
  const active = new Map<string, Work>()
  const work = new Set<Work>()
  const deleting = new Set<string>()
  const elapsedSamples = new Map<string, { elapsedMs: number; sampledAtMs: number }>()
  const listeners = new Set<(event: AiEvent) => void>()
  const pending: { priority: number; run(): Promise<void>; reject(error: unknown): void }[] = []
  let working = false, closing = false
  let lifecycle = Promise.resolve()
  // 任务入库与登记运行器须连续完成，删除不能插入二者之间。
  function control<T>(run: () => Promise<T>): Promise<T> {
    const closed = () => new BoundaryError('AI_CLOSED', '应用正在关闭，请稍后重试。')
    if (closing) return Promise.reject(closed())
    const operation = lifecycle.then(() => { if (closing) throw closed(); return run() })
    lifecycle = operation.then(() => {}, () => {})
    return operation
  }
  const storage = async <T>(method: string, ...args: unknown[]) => await options.storage(method, args) as T
  function withElapsedSample(task: AnalysisTask): AnalysisTask {
    const sample = elapsedSamples.get(task.id)
    return sample && task.state === 'running' && task.elapsedMs === sample.elapsedMs
      ? { ...task, elapsedSampledAtMs: sample.sampledAtMs } : task
  }
  function publish(event: AiEvent) {
    const update = event.kind === 'analysis' ? { ...event, snapshot: withElapsedSample(event.snapshot) } : event
    options.changed?.(update)
    for (const listener of listeners) { try { listener(update) } catch { /* 窗口关闭不能改变任务提交。 */ } }
  }
  function available(conversationId: string) {
    if (deleting.has(conversationId)) throw new BoundaryError('CONVERSATION_DELETING', '会话正在删除，请稍后重试。')
  }
  function schedule<T>(priority: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = pending.indexOf(item)
        if (index >= 0) pending.splice(index, 1)
        signal?.removeEventListener('abort', abort)
        reject(new DOMException('已停止', 'AbortError'))
      }
      const item = { priority, run: async () => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) throw new DOMException('已停止', 'AbortError')
        resolve(await run())
      }, reject }
      if (signal?.aborted) { reject(new DOMException('已停止', 'AbortError')); return }
      signal?.addEventListener('abort', abort, { once: true })
      pending.push(item); pending.sort((a, b) => b.priority - a.priority)
      void drain()
    })
  }
  async function drain() {
    if (working) return
    working = true
    try { while (pending.length) { const item = pending.shift()!; try { await item.run() } catch (error) { item.reject(error) } } } finally { working = false }
  }
  async function modelSecret(model: AiModel) {
    const secret = await storage<{ model: AiModel; encryptedKey: string | null }>('modelSecret', model.id, model.version)
    if (secret.model.version !== model.version) throw new BoundaryError('MODEL_CHANGED', '模型配置已更新，请重新确认。')
    return secret.encryptedKey ? options.secrets.decrypt(secret.encryptedKey) : undefined
  }
  async function runTrackedModel(ownerKind: 'analysis' | 'turn', ownerId: string, requestId: string, input: RuntimeInput, signal: AbortSignal, onText: (text: string) => void, operation: AiOperation, request: Record<string, unknown>, retry?: ModelRetry) {
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    if (input.thinkingLevel) {
      const { model: current } = await storage<{ model: AiModel }>('modelSecret', input.model.id)
      if (!await acceptedThinking(current, input.thinkingLevel) || !await acceptedThinking(input.model, input.thinkingLevel)) throw new BoundaryError('INVALID_MODEL', '请重新选择模型和思考强度。')
    }
    const identity = { ownerKind, ownerId, requestId }
    await storage('recordUsage', { ...identity, usage: { incomplete: true } })
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    try {
      const result = await runDiagnosedModel(options.runtime, input, signal, onText, operation, request, retry)
      await storage('recordUsage', { ...identity, usage: result.usage })
      return result
    } catch (error) {
      const usage = (error as { usage?: AiUsage })?.usage
      if (usage) await storage('recordUsage', { ...identity, usage: { ...usage, incomplete: true } })
      throw error
    }
  }
  async function runTurnModel(id: string, attempt: number, input: RuntimeInput, signal: AbortSignal, onText: (text: string) => void, operation: AiOperation) {
    assertInputFits(input)
    const result = await runTrackedModel('turn', id, `${id}:${attempt}`, input, signal, onText, operation, { attempt })
    if (result.stopReason === 'length') throw new BoundaryError('MODEL_OUTPUT_LIMIT', '回答未完成，请重试或选择更大输出长度的模型。')
    return result
  }
  function launch(key: string, conversationId: string, run: (signal: AbortSignal) => Promise<void>, modelId?: string) {
    available(conversationId)
    if (closing || (active.has(key) && !active.get(key)!.abort.signal.aborted)) return
    const abort = new AbortController()
    const task = Promise.resolve().then(() => run(abort.signal)).finally(() => {
      work.delete(record)
      if (active.get(key)?.abort === abort) active.delete(key)
    })
    const record = { key, conversationId, modelId, abort, task }
    work.add(record)
    active.set(key, record)
    void task.catch(() => {})
    return record
  }
  async function saveAnalysis(id: string, patch: unknown, sampledAtMs?: number) {
    const snapshot = await storage<AnalysisTask>('saveAnalysis', id, patch, ...(sampledAtMs === undefined ? [] : [sampledAtMs]))
    publish({ kind: 'analysis', snapshot })
    return snapshot
  }
  async function submitTask<T extends AnalysisTask | AiTurn>(kind: 'analysis' | 'turn',
    prepare: () => Promise<{ task: T; conversationId: string }>,
    execute: (task: T, signal: AbortSignal, operation: AiOperation) => Promise<void>) {
    const operation = kind === 'analysis' ? aiOperation(options.diagnostics, 'insight', 'generate')
      : aiOperation(options.diagnostics, 'conversation', 'send')
    try {
      const { task, conversationId } = await prepare()
      available(conversationId)
      if (task.state === 'queued') {
        if (launch(`${kind}:${task.id}`, conversationId, signal => execute(task, signal, operation), task.modelId)) return task
        if (closing) { operation.end('interrupted'); return task }
      }
      // 同一提交可能从数据库取回已运行或已结束的任务。
      await operation.discardUnstarted()
      return task
    } catch (error) {
      operation.end('failed', { phase: 'prepare', code: diagnosticErrorCode(error) })
      throw error
    }
  }
  async function saveTurn(id: string, patch: unknown) { const snapshot = await storage<AiTurn>('saveTurn', id, patch); publish({ kind: 'turn', snapshot }); return snapshot }
  async function analysisProcessor(id: string, conversationId: string) {
    const processing = await options.processing?.(conversationId)
    if (!processing) return undefined
    await options.claimProcessing?.(id, hash(processing.settings))
    return createMessageProcessor(processing.settings, processing.members)
  }
  async function executeAnalysis(id: string, signal: AbortSignal, operation: AiOperation, resumeProcessor?: ReturnType<typeof createMessageProcessor>) {
    let phase = 'prepare'
    let analyzedMessages: number | undefined
    let batch: number | undefined
    let attempt = 0
    let pendingRetry: ModelRetry | undefined
    try {
      const initial = await storage<AnalysisContext>('analysisContext', id)
      analyzedMessages = initial.task.analyzedMessages
      const processor = resumeProcessor ?? await analysisProcessor(id, initial.task.conversationId)
      if (signal.aborted) return
      const values = initial.systemPrompts
      const prompts: InsightPrompts = values ? { version: INSIGHT_PROMPT_VERSION, reading: values.insightReading, checking: values.insightChecking, writing: values.insightWriting } : defaultInsightPrompts
      const checkpoint: InsightCheckpoint | null = initial.checkpoint ? JSON.parse(initial.checkpoint) : null
      if (checkpoint && !['reading', 'checking', 'writing'].includes(checkpoint.stage)) {
        throw new BoundaryError('INVALID_INSIGHT_CHECKPOINT', '洞察进度无法恢复，请重新生成。')
      }
      phase = checkpoint?.stage ?? 'reading'
      operation.event(phase, { messageCount: initial.snapshot.sources.length, readCount: analyzedMessages })
      const running = await storage<AnalysisTask>('saveAnalysis', id, { state: 'running', error: undefined })
      const elapsedSample = { elapsedMs: running.elapsedMs ?? 0, sampledAtMs: Date.now() }
      elapsedSamples.set(id, elapsedSample)
      publish({ kind: 'analysis', snapshot: running })
      const report = await generateInsight({ snapshot: initial.snapshot, conversationId: initial.task.conversationId, model: initial.model,
        prompts, limits: defaultInsightRunLimits, checkpoint, elapsedMs: running.elapsedMs, thinkingLevel: initial.task.thinkingLevel }, {
        signal, onText: () => {},
        onRetryPlanned: (shrink, error) => { pendingRetry = { stage: shrink ? 'shrink' : 'retry', code: diagnosticErrorCode(error) } },
        onUnknown: (stage, index) => operation.event('requestUnknown', { phase: stage, attempt: index }),
        read: async messageIds => {
          const sources = await storage<InsightSourceMessage[]>('readInsightSources', { taskId: id, messageIds })
          return sources.map(({ memberId, ...source }) => {
            const protectedSource = processor?.prepare([{ ...source, memberId, kind: 'text' }])[0]
            return protectedSource ? { ...source, text: protectedSource.text, senderName: protectedSource.senderName } : source
          })
        },
        saveCheckpoint: async (state, sampledAtMs) => {
          const snapshot = await storage<AnalysisTask>('saveInsightCheckpoint', id, JSON.stringify(state), state.coveredMessageIds, state.elapsedMs)
          elapsedSample.elapsedMs = state.elapsedMs
          elapsedSample.sampledAtMs = sampledAtMs
          analyzedMessages = snapshot.analyzedMessages
          attempt = state.callsReserved
          batch = state.pendingRead ? state.readLayouts.length + 1 : undefined
          const counts = { readCount: analyzedMessages, messageCount: initial.snapshot.sources.length,
            batch: batch ?? state.readLayouts.length, totalBatches: state.stage !== 'reading' ? state.readLayouts.length : undefined }
          operation.event(state.stage, counts, { progress: phase === state.stage })
          phase = state.stage
          publish({ kind: 'analysis', snapshot })
        },
        saveElapsed: async (elapsedMs, sampledAtMs) => {
          const snapshot = await storage<AnalysisTask>('saveInsightElapsed', id, elapsedMs)
          if (snapshot.state === 'running' && snapshot.elapsedMs === elapsedMs) {
            elapsedSample.elapsedMs = elapsedMs
            elapsedSample.sampledAtMs = sampledAtMs
            publish({ kind: 'analysis', snapshot })
          }
        },
        run: (input, runtimeOptions) => schedule(0, async () => {
          await storage('analysisContext', id)
          const retry = pendingRetry
          pendingRetry = undefined
          return runTrackedModel('analysis', id, randomUUID(), { ...input, apiKey: await modelSecret(initial.model) }, runtimeOptions.signal, runtimeOptions.onText, operation, { phase, batch, attempt }, retry)
        }, runtimeOptions.signal),
      })
      signal.throwIfAborted()
      phase = 'saving'
      operation.event('saving', { readCount: analyzedMessages })
      const snapshot = await storage<AnalysisTask>('completeAnalysis', id, report, elapsedSamples.get(id)?.sampledAtMs)
      publish({ kind: 'analysis', snapshot })
      operation.event('saved', { readCount: snapshot.analyzedMessages })
      operation.end('success', { readCount: snapshot.analyzedMessages })
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof InsightBudgetError) operation.event('budget', { phase, budget: error.budget.name, limit: error.budget.limit })
        operation.end('failed', { phase, code: diagnosticErrorCode(error), readCount: analyzedMessages })
        options.logError?.({ area: 'insight', taskId: id, phase, error, analyzedMessages,
          budget: error instanceof InsightBudgetError ? error.budget : undefined })
        await saveAnalysis(id, { state: 'failed', error: error instanceof BoundaryError ? error.action : '分析失败，请重试。' },
          elapsedSamples.get(id)?.sampledAtMs)
      }
    } finally {
      if (signal.aborted) operation.end(closing ? 'interrupted' : 'cancelled', { phase, readCount: analyzedMessages })
      elapsedSamples.delete(id)
    }
  }
  async function executeTurn(id: string, signal: AbortSignal, operation: AiOperation) {
    let writes = Promise.resolve()
    let phase = 'generate'
    operation.event('queued')
    try {
      let context = await storage<TurnContext>('turnContext', id)
      if (signal.aborted) return
      await saveTurn(id, { state: 'running', error: undefined })
      const result = await schedule(1, async () => {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError')
        context = await storage<TurnContext>('turnContext', id)
        const processing = await options.processing?.(context.conversationId)
        const processor = processing && createMessageProcessor(processing.settings, processing.members)
        const signature = processing ? hash(processing.settings) : undefined
        const instruction = `${context.systemPrompt ?? dialogueSystem}\n相关画像：${JSON.stringify(processor ? processor.data(context.profile) : context.profile)}${context.skill ? `\n本轮技能：\n${context.skill.content}` : ''}`
        const prompt = JSON.stringify({ question: processor ? processor.text(context.turn.prompt) : context.turn.prompt, references: processor ? processor.messages(context.references) : context.references })
        // 默认提示词继续使用升级前的断点目录，自定义提示词单独隔离。
        const keyParts = ['thread', context.turn.threadId, context.selfFingerprint, context.model.id, context.model.version, context.skill?.id, context.skill?.version, signature]
        if (context.systemPrompt && context.systemPrompt !== dialogueSystem) keyParts.push(context.systemPrompt)
        const key = hash(keyParts)
        const budget = resolveModelLimits(context.model).maxInputTokens - 1000
        const fixedSize = Buffer.byteLength(instruction + prompt, 'utf8')
        if (fixedSize > budget) throw new BoundaryError('CONTEXT_TOO_LARGE', '当前问题或引用超出模型容量，请减少引用或选择更大上下文的模型。')
        let history = context.history.map(item => {
          const question = !processor ? item.text : item.role === 'assistant' ? processor.modelText(item.text) : processor.text(item.text)
          return { role: item.role, text: item.references?.length ? JSON.stringify({ question, references: processor ? processor.messages(item.references) : item.references }) : question }
        })
        let checkpoint = context.checkpoint
        if (signature && checkpoint) {
          try { const saved = JSON.parse(checkpoint); checkpoint = saved.processing === signature && typeof saved.checkpoint === 'string' ? saved.checkpoint : null } catch { checkpoint = null }
        }
        while (history.length && fixedSize + Buffer.byteLength(JSON.stringify(history), 'utf8') > budget) { history = history.slice(2); checkpoint = null }
        const response = await runTurnModel(id, context.turn.attempt, { key, model: context.model, thinkingLevel: context.turn.thinkingLevel, apiKey: await modelSecret(context.model), systemPrompt: instruction, prompt, history, checkpoint }, signal, text => {
          if (signal.aborted) return
          writes = writes.then(async () => { if (!signal.aborted) await saveTurn(id, { text }) })
        }, operation)
        return { ...response, checkpoint: signature ? JSON.stringify({ processing: signature, checkpoint: response.checkpoint }) : response.checkpoint }
      }, signal)
      phase = 'saving'
      if (!signal.aborted) operation.event('saving')
      await writes
      if (!signal.aborted) {
        await saveTurn(id, { text: result.text, state: 'completed', checkpoint: result.checkpoint })
        operation.event('saved')
        operation.end('success')
      }
    } catch (error) {
      await writes.catch(() => {})
      if (!signal.aborted) {
        operation.end('failed', { phase, code: diagnosticErrorCode(error) })
        options.logError?.({ area: 'conversation', phase: 'generate', taskId: id, error })
        await saveTurn(id, { state: 'failed', error: error instanceof BoundaryError ? error.action : '回答失败，请重试。' })
      }
    } finally {
      if (signal.aborted) operation.end(closing ? 'interrupted' : 'cancelled', { phase })
    }
  }
  const service: AiMethods = {
    listModels: async () => Promise.all((await storage<AiModel[]>('listModels')).map(async model => { const capability = await reasoningCapabilities(model); return { ...model, ...(capability ? { thinkingLevels: capability.levels } : {}) } })),
    async saveModel(input) { const { apiKey, ...model } = input; const encrypted = apiKey === undefined ? undefined : apiKey ? options.secrets.encrypt(apiKey) : null; return storage('saveModel', model, encrypted) },
    async testModel(modelId) {
      const key = `test:${randomUUID()}`
      const operation = aiOperation(options.diagnostics, 'model', 'test')
      operation.event('queued')
      let timedOut = false
      const record = launch(key, '', async signal => {
        const timeout = setTimeout(() => { timedOut = true; record!.abort.abort() }, 30000)
        try {
          await schedule(1, async () => {
            const { model } = await storage<{ model: AiModel }>('modelSecret', modelId)
            if (!model.enabled) throw new BoundaryError('MODEL_DISABLED', '请启用模型后再检测连接。')
            if (signal.aborted) throw new DOMException('已停止', 'AbortError')
            const input = { key, model, apiKey: await modelSecret(model), systemPrompt: 'Reply OK.', prompt: 'OK' }
            assertInputFits(input)
            await runDiagnosedModel(options.runtime, input, signal, () => {}, operation, { attempt: 1 })
          }, signal)
        } finally { clearTimeout(timeout) }
      }, modelId)
      if (!record) {
        operation.end('interrupted')
        throw new BoundaryError('AI_CLOSED', '应用正在关闭，请稍后重试。')
      }
      try {
        await record.task
        if (timedOut) operation.end('failed', { code: 'MODEL_TIMEOUT' })
        else if (record.abort.signal.aborted) operation.end(closing ? 'interrupted' : 'cancelled')
        else operation.end('success')
      }
      catch (error) {
        if (timedOut) operation.end('failed', { code: 'MODEL_TIMEOUT' })
        else if (record.abort.signal.aborted) operation.end(closing ? 'interrupted' : 'cancelled')
        else operation.end('failed', { code: diagnosticErrorCode(error) })
        if (timedOut || !record.abort.signal.aborted) {
          options.logError?.({ area: 'model', phase: 'testModel', error: timedOut ? new BoundaryError('MODEL_TIMEOUT') : error })
        }
        throw error
      }
    },
    listSkills: () => storage('listSkills'), prepareAnalysis: input => control(async () => { available(input.conversationId); const { model } = await storage<{ model: AiModel }>('modelSecret', input.modelId); return storage('prepareAnalysis', { ...input, thinkingLevel: await acceptedThinking(model, input.thinkingLevel) }) }),
    discardAnalysisPreparation: token => control(() => storage('discardAnalysisPreparation', token)),
    confirmAnalysis: input => control(() => submitTask('analysis', async () => {
      const task = await storage<AnalysisTask>('confirmAnalysis', input)
      return { task, conversationId: task.conversationId }
    }, (task, signal, operation) => {
      operation.bind(task.id, task.createdAtMs)
      operation.event('queued', { messageCount: task.totalMessages })
      return executeAnalysis(task.id, signal, operation)
    })),
    getAnalysis: async id => withElapsedSample(await storage<AnalysisTask>('getAnalysis', id)),
    listAnalyses: async id => (await storage<AnalysisTask[]>('listAnalyses', id)).map(withElapsedSample),
    getReport: id => storage('getReport', id),
    previewInsightScope: input => storage('previewInsightScope', input),
    readInsightCitation: input => storage('readInsightCitation', input),
    renameAnalysis: input => control(async () => {
      const snapshot = await storage<AnalysisTask>('renameAnalysis', input)
      publish({ kind: 'analysis', snapshot })
      return snapshot
    }),
    arrangeAnalysis: change => control(async () => {
      await storage('arrangeAnalysis', change)
      const snapshot = await storage<AnalysisTask>('getAnalysis', change.id)
      publish({ kind: 'analysis', snapshot })
    }),
    deleteAnalysis: id => control(async () => {
      const task = await storage<AnalysisTask>('getAnalysis', id)
      available(task.conversationId)
      const targets = [...work].filter(item => item.key === `analysis:${id}`)
      for (const item of targets) item.abort.abort()
      await Promise.allSettled(targets.map(item => item.task))
      if (['queued', 'running'].includes(task.state)) await saveAnalysis(id, { state: 'stopped' })
      await storage('deleteAnalysis', id)
      publish({ kind: 'analysis-deleted', taskId: id, conversationId: task.conversationId })
    }),
    stopAnalysis: id => control(async () => {
      const task = await storage<AnalysisTask>('getAnalysis', id)
      const running = active.get(`analysis:${id}`)
      const elapsedSample = elapsedSamples.get(id)
      running?.abort.abort()
      // 断点可能在停止过程中更新，确认时用同一次运行的最新计时点。
      if (task.scope) await running?.task.catch(() => {})
      return saveAnalysis(id, { state: 'stopped' }, elapsedSample?.sampledAtMs)
    }),
    continueAnalysis: id => control(async () => {
      const current = await storage<AnalysisTask>('getAnalysis', id)
      available(current.conversationId)
      if (!['stopped', 'interrupted', 'failed'].includes(current.state)) throw new BoundaryError('INVALID_STATE', '请刷新分析进度。')
      const key = `analysis:${id}`
      // 旧请求可能还在登记用量或提交批次，等它退出后再开放本任务的写入。
      await active.get(key)?.task.catch(() => {})
      const recoveredId = current.state === 'interrupted' && typeof current.createdAtMs === 'number'
        ? await options.diagnostics?.findByTask('insight', id, current.createdAtMs).catch(() => null) : null
      const operation = aiOperation(options.diagnostics, 'insight', 'generate', recoveredId)
      operation.bind(id, current.createdAtMs)
      try {
        const processor = await analysisProcessor(id, current.conversationId)
        const task = await storage<AnalysisTask>('resumeAnalysis', id)
        operation.event('recovered', { messageCount: task.totalMessages, readCount: task.analyzedMessages })
        if (!launch(key, task.conversationId, signal => executeAnalysis(id, signal, operation, processor), task.modelId)) operation.end('interrupted')
        return task
      } catch (error) {
        operation.end('failed', { phase: 'prepare', code: diagnosticErrorCode(error) })
        throw error
      }
    }),
    openThread: id => control(async () => { available(id); return storage('openThread', id) }), getThread: id => storage('getThread', id),
    listThreads: id => storage('listThreads', id), createThread: id => control(async () => { available(id); return storage('createThread', id) }),
    arrangeThread: (id, change) => control(async () => { available(id); await storage('arrangeThread', id, change) }),
    deleteThread: (id, threadId) => control(async () => {
      available(id)
      const thread = await storage<AiThread>('getThread', threadId)
      if (thread.conversationId !== id) throw new BoundaryError('INVALID_THREAD', '请选择当前会话中的对话。')
      const turnKeys = new Set(thread.turns.map(turn => `turn:${turn.id}`))
      const targets = [...work].filter(item => turnKeys.has(item.key))
      for (const item of targets) item.abort.abort()
      await Promise.allSettled(targets.map(item => item.task))
      for (const key of new Set(targets.map(item => item.key))) await saveTurn(key.slice(5), { state: 'stopped' })
      await storage('deleteThread', id, threadId)
    }),
    sendTurn: input => control(() => submitTask('turn', async () => {
      const thread = await storage<AiThread>('getThread', input.threadId)
      available(thread.conversationId)
      const { model } = await storage<{ model: AiModel }>('modelSecret', input.modelId)
      const turn = await storage<AiTurn>('createTurn', { ...input, thinkingLevel: await acceptedThinking(model, input.thinkingLevel) })
      return { task: turn, conversationId: thread.conversationId }
    }, (turn, signal, operation) => executeTurn(turn.id, signal, operation))),
    retryTurn: id => control(async () => {
      const context = await storage<TurnContext>('turnContext', id)
      available(context.conversationId)
      const turn = await storage<AiTurn>('beginRetryTurn', id)
      launch(`turn:${id}`, context.conversationId, signal => executeTurn(id, signal, aiOperation(options.diagnostics, 'conversation', 'send')), turn.modelId)
      return turn
    }),
    stopTurn: id => control(async () => { active.get(`turn:${id}`)?.abort.abort(); return saveTurn(id, { state: 'stopped' }) }),
  }
  return { ...service,
    isBusy: () => work.size > 0 || working,
    hasModelWork: ids => [...work].some(item => !!item.modelId && ids.includes(item.modelId)),
    stopModelTasks: ids => control(async () => {
      const targets = [...work].filter(item => !!item.modelId && ids.includes(item.modelId))
      for (const item of targets) item.abort.abort()
      await Promise.allSettled(targets.map(item => item.task))
      for (const key of new Set(targets.map(item => item.key))) {
        const [kind, id] = key.split(':')
        if (kind === 'analysis') await saveAnalysis(id, { state: 'stopped' })
        else if (kind === 'turn') await saveTurn(id, { state: 'stopped' })
      }
    }),
    deleteConversation: (id, remove) => control(async () => {
      available(id)
      deleting.add(id)
      try {
        const targets = [...work].filter(value => value.conversationId === id)
        for (const value of targets) value.abort.abort()
        await Promise.allSettled(targets.map(value => value.task))
        // 删除失败时，留下可继续的停止状态，而非无人处理的运行中任务。
        for (const key of new Set(targets.map(value => value.key))) {
          const [kind, owner] = key.split(':')
          if (kind === 'analysis') await saveAnalysis(owner, { state: 'stopped' })
          else await saveTurn(owner, { state: 'stopped' })
        }
        await remove()
      } finally { deleting.delete(id) }
    }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async idle() { await lifecycle; await Promise.allSettled([...work].map(value => value.task)) },
    async close() { closing = true; for (const value of work) value.abort.abort(); await lifecycle; await Promise.allSettled([...work].map(value => value.task)); await storage('recover') },
  }
}
