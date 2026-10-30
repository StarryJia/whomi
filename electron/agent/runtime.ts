import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AgentRunInput, AgentRunResult } from './protocol'
import type { AiUsage } from '../../src/shared/ai-contract'
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'
export type { AgentRunInput, AgentRunResult } from './protocol'

function failure(code: string, action: string) {
  return Object.assign(new Error(action), { code, action })
}
function abortError() { return new DOMException('回答已停止。', 'AbortError') }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

export class PiRuntime {
  constructor(readonly directory: string) {}
  async run(input: AgentRunInput, options: { signal: AbortSignal; onText: (text: string) => void }): Promise<AgentRunResult> {
    options.signal.throwIfAborted()
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SettingsManager, SessionManager } = await import('@earendil-works/pi-coding-agent')
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

    const provider = `whomi-${key}`
    const modelRuntime = await ModelRuntime.create({
      credentials: { read: async () => undefined, list: async () => [], modify: async (_provider, change) => change(undefined), delete: async () => {} },
      modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    })
    modelRuntime.registerProvider(provider, {
      baseUrl: input.model.baseUrl,
      api: 'openai-completions',
      apiKey: 'whomi-runtime-credential',
      models: [{ id: input.model.model, name: input.model.label, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: input.model.contextWindow, maxTokens: input.model.maxTokens }],
    })
    await modelRuntime.setRuntimeApiKey(provider, input.apiKey ?? 'whomi-no-credential')
    const model = modelRuntime.getModel(provider, input.model.model)
    if (!model) throw failure('MODEL_UNAVAILABLE', '请检查模型配置后重试。')
    if (!input.checkpoint) {
      for (const item of input.history ?? []) {
        if (item.role === 'user') manager.appendMessage({ role: 'user', content: item.text, timestamp: Date.now() })
        else manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: item.text }], api: 'openai-completions', provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() })
      }
    }
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' })
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
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader: loader, settingsManager, sessionManager: manager, tools: [], customTools: [], thinkingLevel: 'off' })
    let text = ''
    let firstTokenMs: number | undefined
    let reported: Record<string, unknown> | undefined
    let final: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
    let stopReason: string | undefined
    const started = performance.now()
    const previousObserver = session.agent.onProviderStreamEvent
    session.agent.onProviderStreamEvent = async (data, selected) => {
      await previousObserver?.(data, selected)
      const chunk = data as { usage?: Record<string, unknown>; choices?: { usage?: Record<string, unknown> }[] }
      const usage = chunk.usage ?? chunk.choices?.[0]?.usage
      if (usage) reported = { ...reported, ...usage }
    }
    const unsubscribe = session.subscribe(event => {
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
      }
    })
    const abort = () => { void session.abort() }
    const usageSnapshot = (): AiUsage => {
      const durationMs = performance.now() - started
      const inputKnown = finite(reported?.prompt_tokens)
      const outputKnown = finite(reported?.completion_tokens)
      const details = reported?.prompt_tokens_details as Record<string, unknown> | undefined
      const cached = details?.cached_tokens ?? reported?.prompt_cache_hit_tokens ?? reported?.cached_tokens
      const cacheKnown = finite(cached)
      const cacheWritten = details?.cache_write_tokens
      const cacheWriteKnown = finite(cacheWritten)
      const inputTokens = final?.input ?? (inputKnown ? Math.max(0, (reported!.prompt_tokens as number) - (cacheKnown ? cached : 0) - (cacheWriteKnown ? cacheWritten : 0)) : undefined)
      const outputTokens = final?.output ?? (outputKnown ? reported!.completion_tokens as number : undefined)
      return {
        ...(inputKnown ? { inputTokens } : {}),
        ...(outputKnown ? { outputTokens, outputTokensPerSecond: outputTokens! / Math.max(durationMs / 1000, 0.001) } : {}),
        ...(cacheKnown ? { cacheReadTokens: final?.cacheRead ?? cached } : {}),
        ...(cacheWriteKnown ? { cacheWriteTokens: final?.cacheWrite ?? cacheWritten } : {}),
        durationMs, firstTokenMs, incomplete: !inputKnown || !outputKnown,
      }
    }
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      if (options.signal.aborted) throw abortError()
      await session.prompt(input.prompt, { expandPromptTemplates: false })
      if (options.signal.aborted || stopReason === 'aborted') throw abortError()
      if (!final || stopReason === 'error' || stopReason === 'pending') throw failure('MODEL_REQUEST_FAILED', '请检查模型服务后重试。')
      const usage = usageSnapshot()
      const sessionFile = manager.getSessionFile()
      const leafId = manager.getLeafId()
      if (!sessionFile || !leafId) throw failure('SESSION_SAVE_FAILED', '请重试保存对话。')
      return { text: text || session.getLastAssistantText() || '', usage, checkpoint: JSON.stringify({ sessionFile, leafId }) }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : failure('MODEL_REQUEST_FAILED', '请检查模型服务后重试。'), { usage: usageSnapshot() })
    } finally {
      options.signal.removeEventListener('abort', abort)
      unsubscribe()
      await session.abort()
      session.dispose()
    }
  }
}
