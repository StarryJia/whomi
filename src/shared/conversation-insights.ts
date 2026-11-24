import type { SourceWindow } from './desktop-api'

export type InsightDimensions = { EI: 'E' | 'I' | null; SN: 'S' | 'N' | null; TF: 'T' | 'F' | null; JP: 'J' | 'P' | null }
export const dimensionKeys = ['EI', 'SN', 'TF', 'JP'] as const

export type InsightScope =
  | { kind: 'all' }
  | { kind: 'dates'; startDate: string; endDate: string; timezone: string }

export type InsightScopeInput = { conversationId: string; scope?: InsightScope }
export type InsightScopePreview = {
  scope: InsightScope
  timezone: string
  totalMessages: number
  analyzableMessages: number
  sourceStartTimeMs: number | null
  sourceEndTimeMs: number | null
}

export type InsightSourceRef = { messageId: string; revision: string }
export type InsightFragment = { sources: InsightSourceRef[] }
export type InsightCitation = { id: string; conversationId: string; fragments: InsightFragment[] }
export type InsightInline = { text: string; citationId?: string }
export type InsightParagraph = { content: InsightInline[] }

export type InsightJudgment = {
  [Dimension in keyof InsightDimensions]: { dimension: Dimension; direction: InsightDimensions[Dimension] }
}[keyof InsightDimensions] & {
  text: string
  supportingSources: InsightSourceRef[]
  counterexampleSources: InsightSourceRef[]
  alternativeExplanations: string[]
  limitations: string[]
}

export type InsightReport = {
  format: 'conversation-insights-v1'
  aboutYou: InsightParagraph[]
  relationship: InsightParagraph[]
  citations: InsightCitation[]
  limitations: string[]
  judgments?: InsightJudgment[]
}

export function judgmentCitation(report: InsightReport, conversationId: string, judgmentIndex: number, kind: 'supporting' | 'counterexample'): InsightCitation | undefined {
  const judgment = report.judgments?.[judgmentIndex]
  const sources = kind === 'supporting' ? judgment?.supportingSources : judgment?.counterexampleSources
  if (!Array.isArray(sources) || !sources.length) return undefined
  // 旧报告的正文可使用任意引用名，包括没有对应原文的引用。
  const occupied = new Set(report.citations.map(citation => citation.id))
  for (const paragraph of [...report.aboutYou, ...report.relationship]) {
    for (const part of paragraph.content) if (part.citationId) occupied.add(part.citationId)
  }
  const base = 'mbti.' + judgmentIndex + '.' + kind
  let id = base
  for (let suffix = 1; occupied.has(id); suffix++) id = base + '.' + suffix
  return { id, conversationId, fragments: sources.map(source => ({ sources: [source] })) }
}

export function resolveReportCitation(report: InsightReport, conversationId: string, id: string): InsightCitation | undefined {
  const citation = report.citations.find(item => item.id === id)
  if (citation) return citation
  const match = /^mbti\.(\d+)\.(supporting|counterexample)(?:\.\d+)?$/.exec(id)
  if (!match) return undefined
  const derived = judgmentCitation(report, conversationId, Number(match[1]), match[2] === 'supporting' ? 'supporting' : 'counterexample')
  return derived?.id === id ? derived : undefined
}

export type InsightSourceMessage = {
  id: string
  revision: string
  senderName: string
  memberId?: string | null
  isSelf: boolean
  text: string
  sentAtMs: number | null
  replyToMessageId: string | null
}

export type InsightSnapshot = {
  taskId: string
  sourceTextBytes?: number
  scope: InsightScope
  timezone: string
  sourceStartTimeMs: number | null
  sourceEndTimeMs: number | null
  sources: InsightSourceRef[]
  createdAtMs: number
}

export type InsightCitationInput = { taskId: string; citationId: string; fragmentIndex: number }
export type InsightCitationWindow =
  | (Extract<SourceWindow, { status: 'available' }> & { highlightIds: string[] })
  | { status: 'expired' }
  | { status: 'unavailable' }

export const defaultInsightTitle = '会话洞察'

function dateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const midnight = new Date(value + 'T00:00:00Z')
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === value
}

export function isInsightTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function isInsightScope(value: unknown): value is InsightScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const fields = Object.keys(value)
  const scope = value as Record<string, unknown>
  if (scope.kind === 'all') return fields.length === 1 && fields[0] === 'kind'
  return scope.kind === 'dates' && fields.length === 4 &&
    fields.every(field => ['kind', 'startDate', 'endDate', 'timezone'].includes(field)) &&
    dateString(scope.startDate) && dateString(scope.endDate) && scope.startDate <= scope.endDate && isInsightTimezone(scope.timezone)
}

export function insightTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.trim()
  return title && title.length <= 160 && [...title].length <= 80 ? title : null
}

export function isInsightReport(report: unknown): report is InsightReport {
  return typeof report === 'object' && report !== null && 'format' in report && report.format === 'conversation-insights-v1'
}
