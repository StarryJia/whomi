import type { AiModelIdentity, AiUsage } from '../../src/shared/ai-contract'
import type { InsightReport } from '../../src/shared/conversation-insights'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { InsightPrompts } from '../data/ai/insight-prompts'
import type { InsightCursor, InsightInputCount } from './insight-packing'

export type InsightRunLimits = {
  maxChecks: number
  maxRoundsPerCheck: number
  maxCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxElapsedMs: number
}

export type InsightNote = { text: string; sourceIds: string[] }
export type InsightMemoryFact = InsightNote & { kind: 'fact' | 'unknown' }
export type InsightEvidenceNote = { sourceId: string; quote: string; text: string }
type InsightNavigationNode = InsightNote & { children: number[]; facts?: InsightMemoryFact[] }
export type InsightNavigation = {
  nodes: InsightNavigationNode[]; roots: number[]; cursor: number; nextRoots: number[]; repairs: number
  factsVersion?: 1 | 2; reconciled?: boolean
}
export type InsightNavigationRequest = { id: number; offset: number }
export type InsightCandidate = { observation: string; supportingIds: string[]; reason?: string }
export type InsightFinding = {
  revisedObservation: string
  supportingIds: string[]
  counterexampleIds: string[]
  alternativeExplanations: string[]
  limitations: string[]
}
export type InsightCheck = InsightCandidate & {
  id: string
  state: 'pending' | 'finished' | 'inconclusive'
  rounds: number
  seenEvidenceIds: string[]
  evidenceNotes: InsightEvidenceNote[]
  navigationRequests: InsightNavigationRequest[]
  pendingNavigation: InsightNavigationRequest | null
  pendingIds: string[]
  pendingCursor: InsightCursor
  pendingThrough: InsightCursor | null
  shrinkDepth: number
  repairs: number
  purpose: string | null
  finding: InsightFinding | null
}

type InsightReadLayout = { from: InsightCursor; to: InsightCursor; depth: number }
export type InsightPendingRead = InsightReadLayout & { repairs: number }
export type InsightStage = 'reading' | 'checking' | 'writing'
export type InsightAttempt = {
  stage: InsightStage
  checkId?: string
  input: InsightInputCount
  reservedOutput: number
  startedAtMs: number
  status: 'pending' | 'returned' | 'failed' | 'unknown'
  usage?: AiUsage
}
export type InsightCheckpoint = {
  version: 1
  sourceTextVersion?: 2
  taskId: string
  modelId: string
  modelVersion: number
  prompts: InsightPrompts
  limits: InsightRunLimits
  stage: InsightStage
  cursor: InsightCursor
  pendingRead: InsightPendingRead | null
  readLayouts: InsightReadLayout[]
  coveredMessageIds: string[]
  observations: InsightNote[]
  openThreads: InsightNote[]
  navigation: InsightNavigation | null
  checks: InsightCheck[]
  callsReserved: number
  elapsedMs: number
  attempts: InsightAttempt[]
  writingRepairs: number
  report: InsightReport | null
}

export const startingInsightCursor: InsightCursor = { messageIndex: 0, textOffset: 0 }

export function createInsightCheckpoint(
  taskId: string, model: AiModelIdentity, prompts: InsightPrompts, limits: InsightRunLimits,
): InsightCheckpoint {
  const values = [limits.maxChecks, limits.maxRoundsPerCheck, limits.maxCalls, limits.maxInputTokens, limits.maxOutputTokens, limits.maxElapsedMs]
  if (values.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new BoundaryError('INVALID_INSIGHT_LIMITS', '请检查洞察预算后重新生成。')
  }
  return {
    version: 1, sourceTextVersion: 2, taskId, modelId: model.id, modelVersion: model.version, prompts, limits, stage: 'reading',
    cursor: startingInsightCursor, pendingRead: null, readLayouts: [], coveredMessageIds: [], observations: [],
    openThreads: [], navigation: null, checks: [], callsReserved: 0, elapsedMs: 0, attempts: [], writingRepairs: 0, report: null,
  }
}

export type InsightBudgetLimit = { name: keyof InsightRunLimits; limit: number }

export class InsightBudgetError extends BoundaryError {
  constructor(readonly budget: InsightBudgetLimit) {
    super('INSIGHT_BUDGET_EXHAUSTED', '已达到洞察预算。请缩短日期范围后重新生成。')
  }
}

export function remainingInsightBudget(state: InsightCheckpoint) {
  let inputTokens = state.limits.maxInputTokens
  let outputTokens = state.limits.maxOutputTokens
  for (const attempt of state.attempts) {
    const usage = attempt.usage
    const reportedTotal = usage?.totalInputTokens ?? (usage?.inputTokens === undefined ? undefined
      : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
    // 请求失败或缺少真实用量时继续占用预留，实际用量单独保留。
    inputTokens -= reportedTotal ?? attempt.input.tokens
    outputTokens -= usage?.outputTokens ?? attempt.reservedOutput
  }
  return {
    calls: state.limits.maxCalls - state.callsReserved,
    inputTokens,
    outputTokens,
    elapsedMs: state.limits.maxElapsedMs - state.elapsedMs,
  }
}
