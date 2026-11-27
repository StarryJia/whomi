import { insightModelProtocol, reasoningCapabilities } from './reasoning-capabilities'
import { resolveAgentModelCapacity } from './model-capacity'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AgentRunInput, AgentRunResult, InsightRuntimeCallbacks } from './protocol'
import { createInsightTool, observeInsightSession } from './insight-session'
import { insightRequestError } from './insight-request-failure'
import type { AiUsage } from '../../src/shared/ai-contract'
import { modelContextLimit } from '../../src/shared/model-limits'
import { defaultModelProtocol, isModelProtocol, modelProtocolBaseUrl } from '../../src/shared/model-protocol'
import { protocolUsage } from './protocol-usage'
import { isPiTimeout, isProviderTimeout, modelTimeout } from './model-timeout'
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'
export type { AgentRunInput, AgentRunResult } from './protocol'

function failure(code: string, action: string) {
  return Object.assign(new Error(action), { code, action })
}
function abortError() { return new DOMException('回答已停止。', 'AbortError') }

export class PiRuntime {
  constructor(readonly directory: string) {}
  async run(input: AgentRunInput, options: { signal: AbortSignal; onText: (text: string) => void; insight?: InsightRuntimeCallbacks }): Promise<AgentRunResult> {
    options.signal.throwIfAborted()
    const configuredApi = input.model.protocol ?? defaultModelProtocol
    if (!isModelProtocol(configuredApi)) throw failure('INVALID_MODEL', '请选择连接协议后重试。')
    const baseUrl = modelProtocolBaseUrl(input.model.baseUrl, configuredApi)
    const api = input.insightSession ? insightModelProtocol(input.model) : configuredApi
    const useInsightResponses = !!input.insightSession && api === 'openai-responses' && baseUrl === 'https://api.openai.com/v1'
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SettingsManager, SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { isContextOverflow, isRetryableAssistantError } = await import('@earendil-works/pi-ai')
    options.signal.throwIfAborted()
    const agentDir = join(this.directory, 'ai-runtime')
    const key = createHash('sha256').update(input.key).digest('hex')
    const cwd = join(agentDir, 'workspace')
    const sessionDir = join(agentDir, 'sessions', key)
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    let manager: ReturnType<typeof SessionManager.create>
    if (input.checkpoint) {
      try {
        const checkpoint = JSON.parse(input.checkpoint) as { sessionFile: unknown; leafId: unknown }
        if (typeof checkpoint.sessionFile !== 'string' || typeof checkpoint.leafId !== 'string' ||
          !existsSync(checkpoint.sessionFile) || dirname(realpathSync(checkpoint.sessionFile)) !== realpathSync(sessionDir) ||
          !checkpoint.sessionFile.endsWith('.jsonl')) throw new Error('invalid checkpoint')
        manager = SessionManager.open(resolve(checkpoint.sessionFile), sessionDir, cwd)
        if (!manager.getEntry(checkpoint.leafId)) throw new Error('missing leaf')
        // branch 只改变内存指针，每次恢复都必须重设已提交位置。
        manager.branch(checkpoint.leafId)
      } catch { throw failure('INVALID_CHECKPOINT', '请重新打开对话后重试。') }
    } else manager = SessionManager.create(cwd, sessionDir)

    // 切换服务商后隔离模型身份，避免重放同名模型的签名推理。
    const modelKey = input.insightSession?.modelSessionKey
    const provider = `whomi-${key}${modelKey ? '-' + createHash('sha256').update(modelKey).digest('hex').slice(0, 16) : ''}`
    const modelRuntime = await ModelRuntime.create({
      credentials: { read: async () => undefined, list: async () => [], modify: async (_provider, change) => change(undefined), delete: async () => {} },
      modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    })
    const autonomous = input.insightSession
    if (autonomous && (!options.insight || input.history !== undefined)) throw failure('INVALID_INSIGHT_SESSION', '请重新打开洞察任务。')
    const effectiveModel = useInsightResponses ? { ...input.model, protocol: api } : input.model
    const capabilities = await reasoningCapabilities(effectiveModel)
    const thinkingLevel = input.thinkingLevel && capabilities?.levels.includes(input.thinkingLevel) ? input.thinkingLevel : undefined
    const limits = await resolveAgentModelCapacity(effectiveModel, thinkingLevel)
    const defaultOutput = autonomous ? limits.maxTokens : limits.requestDefaultOutputTokens ?? limits.maxTokens
    const outputLimit = Math.min(input.outputTokenLimit ?? defaultOutput, limits.maxTokens)
    modelRuntime.registerProvider(provider, {
      baseUrl,
      api,
      ...(autonomous?.headers ? { headers: autonomous.headers } : {}),
      apiKey: 'whomi-runtime-credential',
      models: [{ id: input.model.model, name: input.model.label, reasoning: !!thinkingLevel,
        ...(capabilities?.model?.thinkingLevelMap ? { thinkingLevelMap: capabilities.model.thinkingLevelMap } : {}),
        // Responses 需要显式 strict:false，才能按工具声明省略可选的分页参数。
        compat: useInsightResponses ? { supportsStrictMode: true } : capabilities?.compat,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: limits.contextWindow, maxTokens: outputLimit }],
    })
    await modelRuntime.setRuntimeApiKey(provider, input.apiKey ?? 'whomi-no-credential')
    const model = modelRuntime.getModel(provider, input.model.model)
    if (!model) throw failure('MODEL_UNAVAILABLE', '请检查模型配置后重试。')
    if (input.history !== undefined) {
      // 显式历史已按当前隐私规则处理，不能被断点中的原始回答替代。
      if (input.checkpoint) manager = SessionManager.create(cwd, sessionDir)
      for (const item of input.history) {
        if (item.role === 'user') manager.appendMessage({ role: 'user', content: item.text, timestamp: Date.now() })
        else manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: item.text }], api, provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() })
      }
    }
    const compaction = autonomous ? {
      enabled: true,
      reserveTokens: limits.contextWindow - limits.maxInputTokens + Math.ceil(limits.maxInputTokens / 5),
      keepRecentTokens: Math.floor(limits.maxInputTokens / 4),
    } : { enabled: false }
    const settingsManager = SettingsManager.inMemory({ compaction, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' })
    const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() }
    const loader: ResourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => input.systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    }
    const reader = autonomous && options.insight ? createInsightTool(options.insight, limits.maxInputTokens, () => {
      // When usage is unreported, our conservative page estimate can run out before Pi's threshold.
      settingsManager.applyOverrides({ compaction: { ...compaction, reserveTokens: limits.contextWindow } })
    }) : undefined
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader: loader, settingsManager, sessionManager: manager,
      tools: reader ? ['read_messages'] : [], customTools: reader ? [reader.tool] : [], thinkingLevel: thinkingLevel ?? 'off' })
    if (useInsightResponses || capabilities?.supportsReasoningInclude === false) {
      // 原生压缩也使用同一条流，不同 Responses 服务对加密推理回放的支持不同。
      const stream = session.agent.streamFunction
      session.agent.streamFunction = (selected, context, options) => stream(selected, context, { ...options,
        onPayload: async (payload, model) => {
          const request = await options?.onPayload?.(payload, model) ?? payload
          if (!request || typeof request !== 'object') return request
          if (useInsightResponses) {
            const include = 'include' in request && Array.isArray(request.include) ? request.include : []
            return { ...request, include: [...new Set([...include, 'reasoning.encrypted_content'])] }
          }
          if (!('include' in request)) return request
          const { include: _include, ...supported } = request
          return supported
        } })
    }
    const observed = autonomous && options.insight && reader
      ? observeInsightSession(session, manager, options.insight, autonomous.processing, input.systemPrompt, options.signal, reader,
        { maxTokens: outputLimit, maxInputTokens: limits.maxInputTokens }, api, autonomous.fixedPromptLength)
      : undefined
    let text = ''
    let firstTokenMs: number | undefined
    let reported: AiUsage = {}
    let final: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
    let stopReason: string | undefined
    let contextExceeded = false
    let timedOut = false
    let retryableEmptyResponse = false
    const started = performance.now()
    const startedAt = Date.now()
    const previousObserver = session.agent.onProviderStreamEvent
    session.agent.onProviderStreamEvent = async (data, selected) => {
      await previousObserver?.(data, selected)
      reported = protocolUsage(api, data, reported)
    }
    const unsubscribe = session.subscribe(event => {
      if (reader && event.type === 'compaction_end') settingsManager.applyOverrides({ compaction })
      if (event.type === 'agent_end' && observed?.isFullyReviewed()) {
        const last = event.messages.at(-1)
        // Pi 在 agent_end 后检查阈值。成稿后无需给下一轮腾空间，窗口溢出仍交给 Pi 恢复。
        if (last?.role === 'assistant' && last.stopReason === 'stop' && !last.content.some(block => block.type === 'toolCall')
          && !isContextOverflow(last, limits.contextWindow)) settingsManager.applyOverrides({ compaction: { enabled: false } })
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        if (options.signal.aborted) return
        const delta = event.assistantMessageEvent.delta
        if (delta && firstTokenMs === undefined) firstTokenMs = performance.now() - started
        text += delta
        options.onText(text)
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        final = event.message.usage
        stopReason = event.message.stopReason
        contextExceeded = stopReason === 'error' && isContextOverflow(event.message)
        timedOut = input.purpose === 'insight' && stopReason === 'error' && isPiTimeout(api, event.message.errorMessage)
        retryableEmptyResponse = !!autonomous && isRetryableAssistantError(event.message)
          && event.message.content.length === 0 && event.message.usage.totalTokens === 0
      }
    })
    const abort = () => { void session.abort() }
    const usageSnapshot = (): AiUsage => {
      const durationMs = performance.now() - started
      return {
        ...reported,
        ...(reported.outputTokens === undefined ? {} : { outputTokensPerSecond: reported.outputTokens / Math.max(durationMs / 1000, 0.001) }),
        durationMs, firstTokenMs, startedAt, completedAt: Date.now(), incomplete: reported.inputTokens === undefined || reported.outputTokens === undefined,
      }
    }
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      if (options.signal.aborted) throw abortError()
      await session.prompt(input.prompt, { expandPromptTemplates: false })
      await observed?.flush()
      if (options.signal.aborted || stopReason === 'aborted') throw abortError()
      const recoveryFailure = observed?.recoveryFailure()
      if (recoveryFailure) throw Object.assign(insightRequestError(recoveryFailure), { retryable: false })
      if (contextExceeded) throw modelContextLimit()
      if (timedOut) throw modelTimeout()
      if (!final || stopReason === 'error' || stopReason === 'pending') {
        const code = observed?.lastFailure()
        if (observed) throw Object.assign(insightRequestError(code ?? 'MODEL_REQUEST_FAILED'), { retryable: retryableEmptyResponse })
        throw failure('MODEL_REQUEST_FAILED', '请检查模型服务后重试。')
      }
      const usage = usageSnapshot()
      const sessionFile = manager.getSessionFile()
      const leafId = manager.getLeafId()
      if (!sessionFile || !leafId) throw failure('SESSION_SAVE_FAILED', '请重试保存对话。')
      return { ...(stopReason === 'length' ? { stopReason: 'length' as const } : {}), text: observed ? observed.lastText() : text || session.getLastAssistantText() || '', usage, checkpoint: JSON.stringify({ sessionFile, leafId }) }
    } catch (error) {
      if (!options.signal.aborted && input.purpose === 'insight' && error instanceof Error && isProviderTimeout(error)) {
        throw Object.assign(modelTimeout(), { usage: usageSnapshot() })
      }
      throw Object.assign(error instanceof Error ? error : failure('MODEL_REQUEST_FAILED', '请检查模型服务后重试。'), { usage: usageSnapshot() })
    } finally {
      options.signal.removeEventListener('abort', abort)
      unsubscribe()
      await session.abort()
      session.dispose()
    }
  }
}
