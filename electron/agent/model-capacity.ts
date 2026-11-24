import { resolveModelLimits, type ModelLimits, type ModelLimitSettings } from '../../src/shared/model-limits'
import type { ThinkingLevel } from '../../src/shared/thinking'
import { officialModelProfile, type ModelIdentity } from './official-model-profile'
import { registeredModel } from './reasoning-capabilities'

type CapacityModel = ModelLimitSettings & ModelIdentity
type CapacitySource = 'configured' | 'catalog' | 'estimated'
export async function resolveAgentModelCapacity(model: CapacityModel, thinking?: ThinkingLevel) {
  const official = officialModelProfile(model, thinking)
  let catalog: ModelLimits | undefined
  if (model.contextWindow == null || model.maxTokens == null || model.maxInputTokens == null) {
    catalog = official?.limits ?? await registeredModel(model)
  }
  const fallback: CapacitySource = catalog ? 'catalog' : 'estimated'
  const contextSource: CapacitySource = model.contextWindow != null ? 'configured' : fallback
  const outputSource: CapacitySource = model.maxTokens != null ? 'configured' : fallback
  const limits = resolveModelLimits(model, catalog)
  const defaultOutput = model.maxTokens == null ? official?.requestDefaultOutputTokens : undefined
  return { ...limits, contextSource, outputSource,
    ...(defaultOutput != null && { requestDefaultOutputTokens: Math.min(defaultOutput, limits.maxTokens) }) }
}
