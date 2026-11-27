import type { InsightDimensions } from '../../../src/shared/conversation-insights'

export type InsightEvidenceCard = {
  period: string
  events: { summary: string; options: string; selfChoice: string; counterpartResponse: string; messageIds: string[] }[]
  selfSignals: {
    dimension: keyof InsightDimensions
    observation: string
    directionHint: InsightDimensions[keyof InsightDimensions]
    supportingIds: string[]
    counterexampleIds: string[]
    excerpts: { messageId: string; text: string }[]
  }[]
  riskSignals: { fact: string; messageIds: string[] }[]
  revisions: { targetSegment: number; kind: 'behavior_change' | 'added_context'; priorClaim: string; revisedObservation: string; messageIds: string[] }[]
  openThreads: { text: string; messageIds: string[] }[]
}

export type InsightEvidenceCardRecord = {
  segmentIndex: number
  startMessageId: string
  endMessageId: string
  startTimeMs: number | null
  endTimeMs: number | null
  data: InsightEvidenceCard
}
