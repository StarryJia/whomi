import type { InsightRunLimits } from './insight-checkpoint'

// 发布前须用同材料、同模型的质量比较核定；任务快照保留其启动时的值。
export const defaultInsightRunLimits: Readonly<InsightRunLimits> = {
  maxChecks: 8,
  maxRoundsPerCheck: 4,
  maxCalls: 64,
  maxInputTokens: 500_000,
  maxOutputTokens: 32_768,
  maxElapsedMs: 30 * 60 * 1000,
}
