import type { AiModel } from '../../src/shared/ai-contract'
import type { ModelLimits } from '../../src/shared/model-limits'
import { defaultModelProtocol, modelProtocolBaseUrl } from '../../src/shared/model-protocol'
import type { ThinkingLevel } from '../../src/shared/thinking'

export type ModelIdentity = Pick<AiModel, 'model' | 'baseUrl' | 'protocol' | 'planProvider' | 'planAccount'>
export type ModelReasoning = {
  levels: ThinkingLevel[]
  model?: { thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }
  compat?: { thinkingFormat: 'qwen' | 'deepseek'; supportsReasoningEffort: boolean }
  supportsReasoningInclude?: false
}
type OfficialModelProfile = {
  limits: ModelLimits
  reasoning?: ModelReasoning
  requestDefaultOutputTokens?: number
}

export function officialModelProfile(input: ModelIdentity, thinking?: ThinkingLevel): OfficialModelProfile | undefined {
  // 官方服务与同名订阅、代理可以有不同容量。
  if (input.planAccount || input.planProvider) return undefined
  const protocol = input.protocol ?? defaultModelProtocol
  if (protocol !== 'openai-completions' && protocol !== 'openai-responses') return undefined
  const base = modelProtocolBaseUrl(input.baseUrl, protocol)
  if (base === 'https://api.openai.com/v1' && input.model === 'gpt-6.1-sol') {
    return { limits: { contextWindow: 1_050_000, maxTokens: 128_000 } } // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  }
  if (protocol === 'openai-completions' && base === 'https://dashscope.aliyuncs.com/compatible-mode/v1' && input.model === 'qwen3.7-plus') {
    // https://help.aliyun.com/zh/model-studio/qwen3-7-plus
    return {
      limits: { contextWindow: 1_000_000, maxInputTokens: thinking === 'off' ? 991_808 : 983_616, maxTokens: 131_072 },
      reasoning: { levels: ['off', 'high'], compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false } },
    }
  }
  if ((base === 'https://api.deepseek.com' || base === 'https://api.deepseek.com/v1') &&
      (input.model === 'deepseek-flash' || input.model === 'deepseek-v4-pro')) {
    // https://api-docs.deepseek.com/api/create-chat-completion/ 各模式共用硬上限，省略参数时的配额按模式取值。
    return {
      limits: { contextWindow: 1_048_576, maxTokens: 393_216 },
      requestDefaultOutputTokens: thinking === 'off' ? 8_192 : thinking === 'max' ? 131_072 : 65_536,
      reasoning: {
        levels: ['off', 'low', 'high', 'max'],
        model: { thinkingLevelMap: { off: 'none', low: 'low', high: 'high', max: 'max' } },
        ...(protocol === 'openai-completions'
          ? { compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true } }
          : { supportsReasoningInclude: false }),
      },
    }
  }
}
