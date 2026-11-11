import { acceptedThinking, reasoningCapabilities } from '../agent/reasoning-capabilities'
import OpenAI from 'openai'
import { chatgptBaseUrl } from '../../src/shared/chatgpt-plan'
import { isContextLimitCode, modelContextLimit } from '../../src/shared/model-limits'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { RuntimeRunner } from './ai-service'

function planError(code?: string | null, status?: number) {
  if (isContextLimitCode(code)) return modelContextLimit()
  if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'rate_limit_exceeded' || code === 'insufficient_quota' || status === 429) {
    return new BoundaryError('CHATGPT_LIMIT', '请到 ChatGPT 用量设置查看额度，稍后重试。')
  }
  if (code === 'subscription_sharing_route_not_supported' || code === 'subscription_sharing_unsupported_capability') {
    return new BoundaryError('CHATGPT_UNSUPPORTED', 'ChatGPT 套餐不支持本次请求，请更换模型或接入方式。')
  }
  if (code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context' ||
      code === 'subscription_sharing_invalid_user' || status === 401) {
    return new BoundaryError('CHATGPT_ACCESS', '请核对当前 ChatGPT 账户和套餐授权。')
  }
  if (code === 'subscription_sharing_user_not_eligible' || status === 403) {
    return new BoundaryError('CHATGPT_INELIGIBLE', '当前账户或工作区无法使用此套餐请求，请选择其他账户或模型。')
  }
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503) {
    return new BoundaryError('CHATGPT_UNAVAILABLE', 'ChatGPT 套餐服务暂不可用，请稍后重试。')
  }
  return new BoundaryError('CHATGPT_REQUEST', 'ChatGPT 请求失败，请检查连接后重试。')
}

export function createChatgptRunner(accessToken: (accountId: string, signal: AbortSignal) => Promise<string>, fetcher: typeof fetch = fetch): RuntimeRunner {
  return { async run(input, { signal, onText }) {
    const { model } = input
    if ((model.planProvider && model.planProvider !== 'openai-codex') || !model.planAccount || model.baseUrl !== chatgptBaseUrl || model.protocol !== 'openai-responses') throw new BoundaryError('INVALID_MODEL', '请重新添加 ChatGPT 套餐模型。')
    signal.throwIfAborted()
    const apiKey = await accessToken(model.planAccount, signal)
    const client = new OpenAI({ apiKey, baseURL: chatgptBaseUrl, logLevel: 'off', organization: null, project: null, fetch: fetcher, fetchOptions: { redirect: 'error' }, maxRetries: 0 })
    const startedAt = Date.now()
    let text = '', firstTokenMs: number | undefined
    try {
      const level = await acceptedThinking(model, input.thinkingLevel)
      const mapped = level && model.thinkingLevels === undefined ? (await reasoningCapabilities(model))?.model?.thinkingLevelMap?.[level] : undefined
      const stream = await client.responses.create({
        ...(level && mapped !== null ? { reasoning: { effort: (mapped ?? (level === 'off' ? 'none' : level)) as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } } : {}),
        model: model.model, store: false, stream: true, instructions: input.systemPrompt,
        input: [...(input.history ?? []).map(item => ({ role: item.role, content: item.text })), { role: 'user', content: input.prompt }],
      }, { signal })
      for await (const event of stream) {
        signal.throwIfAborted()
        if (event.type === 'response.output_text.delta') {
          if (event.delta) { firstTokenMs ??= Date.now() - startedAt; text += event.delta; onText(text) }
        } else if ((event.type === 'response.completed' && event.response.status === 'completed' && text.trim()) ||
          (event.type === 'response.incomplete' && event.response.incomplete_details?.reason === 'max_output_tokens')) {
          const completedAt = Date.now(), durationMs = completedAt - startedAt
          const usage = event.response.usage, cached = usage?.input_tokens_details?.cached_tokens ?? 0
          return { ...(event.type === 'response.incomplete' ? { stopReason: 'length' as const } : {}), text, checkpoint: '', usage: { startedAt, completedAt, durationMs, firstTokenMs,
            ...(usage ? { totalInputTokens: usage.input_tokens, inputTokens: Math.max(0, usage.input_tokens - cached),
              cacheReadTokens: cached, outputTokens: usage.output_tokens, outputTokensPerSecond: usage.output_tokens / Math.max(.001, durationMs / 1000) } : { incomplete: true }) } }
        } else if (event.type === 'response.failed') {
          throw planError(event.response.error?.code)
        } else if (event.type === 'error') {
          throw planError(event.code)
        } else if (event.type === 'response.incomplete') break
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof BoundaryError) throw error
      if (error instanceof OpenAI.APIError) throw planError(error.code, error.status)
      throw planError()
    }
    throw new BoundaryError('CHATGPT_INCOMPLETE', 'ChatGPT 未返回完整回答，请重试。')
  } }
}
