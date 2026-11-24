import type { AiModel } from './ai-contract'
import { BoundaryError } from './desktop-validation'

export function isContextLimitCode(code: unknown) { return code === 'context_length_exceeded' }
export const modelContextLimit = () => new BoundaryError('MODEL_CONTEXT_LIMIT', '服务商拒绝了过长的输入，请核对模型的最大输入长度。')

// Cherry Studio f19aa72: agentContextWindow.ts and pi/modelInjection.ts (AGPL-3.0).
const DEFAULT_CONTEXT_WINDOW = 256_000
const DEFAULT_MAX_INPUT_TOKENS = 144_000
const DEFAULT_MAX_TOKENS = 128_000

export type ModelLimitSettings = Pick<AiModel, 'contextWindow' | 'maxTokens' | 'maxInputTokens'>
export type ModelLimits = { contextWindow: number; maxTokens: number; maxInputTokens?: number }

export function resolveModelLimits(model: ModelLimitSettings, catalog?: ModelLimits) {
  const contextWindow = model.contextWindow ?? catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const defaultOutput = catalog?.maxTokens ?? DEFAULT_MAX_TOKENS
  // 模型的输出额度放不进较小的配置窗口时，为输入、输出各留一半。
  const maxTokens = model.maxTokens ?? (defaultOutput >= contextWindow ? Math.floor(contextWindow / 2) : defaultOutput)
  if (maxTokens < 1) throw new BoundaryError('INVALID_MODEL_LIMITS', '请增加上下文长度或减少最大输出长度。')
  if (model.maxTokens != null && model.maxTokens >= contextWindow) throw new BoundaryError('INVALID_MODEL_LIMITS', '请填写更大的上下文长度或减少最大输出长度。')
  // 独立输入上限允许长输入与短输出搭配；没有该项的目录按预留完整输出估算。
  const remainingInput = contextWindow - maxTokens
  const estimatedInput = contextWindow < DEFAULT_MAX_INPUT_TOKENS && model.maxTokens != null ? remainingInput : DEFAULT_MAX_INPUT_TOKENS
  const defaultInput = catalog?.maxInputTokens ?? (catalog ? remainingInput : estimatedInput)
  const maxInputTokens = Math.min(model.maxInputTokens ?? defaultInput, contextWindow)
  return { contextWindow, maxTokens, maxInputTokens }
}
