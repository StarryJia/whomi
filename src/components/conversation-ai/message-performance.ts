// Adapted from Cherry Studio messagePerformance.ts buildLegacyViewModel, f19aa72 (AGPL-3.0).
import type { GenerationUsage } from './types'

export function messagePerformance(usage: GenerationUsage) {
  const completion = usage.durationMs
  const outputTokens = usage.outputTokens
  const firstToken = completion === undefined || usage.firstTokenMs === undefined ? undefined : Math.min(Math.max(usage.firstTokenMs, 0), completion)
  const generationDuration = completion === undefined || firstToken === undefined ? undefined : completion - firstToken
  const modelTokensPerSecond = outputTokens !== undefined && outputTokens > 0 && generationDuration !== undefined && generationDuration > 0
    ? outputTokens / (generationDuration / 1000) : undefined
  const endToEndTokensPerSecond = completion !== undefined && completion > 0 && outputTokens !== undefined && outputTokens > 0
    ? outputTokens / (completion / 1000) : undefined
  // Pi reports uncached input separately; the card's Input metric includes all cache lanes.
  const inputTokens = usage.totalInputTokens ?? (usage.inputTokens === undefined ? undefined
    : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
  return { inputTokens, uncachedTokens: usage.inputTokens, modelTokensPerSecond, endToEndTokensPerSecond }
}
