import type { AiModel } from './ai-contract'
import { BoundaryError } from './desktop-validation'

export function isContextLimitCode(code: unknown) { return code === 'context_length_exceeded' }
export const modelContextLimit = () => new BoundaryError('MODEL_CONTEXT_LIMIT', '服务商拒绝了过长的输入，请核对模型的最大输入长度。')

// Cherry Studio f19aa72: agentContextWindow.ts and pi/modelInjection.ts (AGPL-3.0).
const DEFAULT_CONTEXT_WINDOW = 256_000
const DEFAULT_MAX_TOKENS = 8192

export function resolveModelLimits(model: Pick<AiModel, 'contextWindow' | 'maxTokens' | 'maxInputTokens'>) {
  const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = model.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow - 1)
  if (maxTokens < 1) throw new BoundaryError('INVALID_MODEL_LIMITS', '请增加上下文长度或减少最大输出长度。')
  if (model.maxTokens != null && model.maxTokens >= contextWindow) throw new BoundaryError('INVALID_MODEL_LIMITS', '请填写更大的上下文长度或减少最大输出长度。')
  const maxInputTokens = Math.min(model.maxInputTokens ?? contextWindow, contextWindow - maxTokens)
  return { contextWindow, maxTokens, maxInputTokens }
}
