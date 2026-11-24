export type InsightReadRequest = { cursor?: string; messageId?: string; before?: number; after?: number }

export type InsightReadMessage = {
  id: string
  senderName: string
  isSelf: boolean
  sentAtMs: number | null
  replyToMessageId: string | null
  text: string
  fragment?: { start: number; end: number; length: number }
}

export type InsightReadPage =
  | { status: 'ok'; messages: InsightReadMessage[]; nextCursor: string | null }
  | { status: 'out_of_scope' | 'source_changed' | 'invalid_request' | 'insufficient_capacity'; message: string }

export type InsightReadSpan = { messageId: string; start: number; end: number; length: number; review?: true }
export type InsightReadResult = { page: InsightReadPage; spans: InsightReadSpan[] }
export type InsightCoverage = { coveredMessageIds: string[]; partial: Record<string, [number, number][]> }
