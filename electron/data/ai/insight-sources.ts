import { createHash } from 'node:crypto'
import type { InsightScope, InsightScopePreview, InsightSnapshot, InsightSourceMessage, InsightSourceRef } from '../../../src/shared/conversation-insights'
import { BoundaryError } from '../../../src/shared/desktop-validation'
import type { Store } from '../db/open'
import { confirmedSelfSql } from '../db/self'

type SourceRow = {
  id: bigint
  conversation_id: bigint
  member_id: bigint | null
  sender_kind: string
  sender_name: string
  kind: string
  text: string
  is_self: bigint
  sent_at_ms: bigint | null
  reply_to_message_id: bigint | null
  reply_original_id: string | null
  reply_namespace: string | null
}
export type StoredInsightSourceRef = InsightSourceRef & { originalRevision: string }
export type StoredInsightSnapshot = Omit<InsightSnapshot, 'sources'> & { sources: StoredInsightSourceRef[] }

function sourceMessage(row: SourceRow): InsightSourceMessage & Pick<StoredInsightSourceRef, 'originalRevision'> {
  const id = String(row.id)
  const memberId = row.member_id?.toString() ?? null
  const isSelf = row.is_self === 1n
  const sentAtMs = row.sent_at_ms === null ? null : Number(row.sent_at_ms)
  const replyToMessageId = row.reply_to_message_id === null ? null : String(row.reply_to_message_id)
  // 已保存的引用在本人重新确认或回复关系补全后仍应定位到同一条原文。
  const originalRevision = createHash('sha256').update(JSON.stringify([
    id, String(row.conversation_id), memberId, row.sender_kind, row.sender_name,
    row.kind, row.text, sentAtMs,
  ])).digest('hex')
  const revision = createHash('sha256').update(JSON.stringify([
    originalRevision, isSelf, replyToMessageId, row.reply_original_id, row.reply_namespace,
  ])).digest('hex')
  return { id, revision, originalRevision, senderName: row.sender_name, memberId, isSelf, text: row.text, sentAtMs, replyToMessageId }
}

function insightRows(db: Store['reader'], conversationId: bigint, messageIds?: readonly string[]): SourceRow[] {
  const ids = messageIds === undefined ? '' : ' AND x.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))'
  // 逐条读取只来自任务启动时保存的来源清单。新任务选材直接使用当前分类。
  const legacyJoin = messageIds === undefined ? '' : 'LEFT JOIN legacy_insight_source_classification l ON l.message_id=x.id'
  const field = (column: 'member_id' | 'sender_kind' | 'sender_name' | 'kind') =>
    messageIds === undefined ? `x.${column}` : `CASE WHEN l.message_id IS NULL THEN x.${column} ELSE l.${column} END`
  return db.prepare(`SELECT x.id,x.conversation_id,${field('member_id')} AS member_id,${field('sender_kind')} AS sender_kind,
    ${field('sender_name')} AS sender_name,${field('kind')} AS kind,x.text,x.sent_at_ms,
    coalesce((SELECT ${confirmedSelfSql} FROM memberships m WHERE m.id=(${field('member_id')}) AND m.conversation_id=x.conversation_id),0) AS is_self,
    r.target_message_id AS reply_to_message_id, r.original_id AS reply_original_id, r.id_namespace AS reply_namespace
    FROM messages x ${legacyJoin} LEFT JOIN message_replies r ON r.message_id=x.id AND r.conversation_id=x.conversation_id
    WHERE x.conversation_id=?${ids} ORDER BY x.time_bucket,x.sort_time,x.id`)
    .all(conversationId, ...(messageIds === undefined ? [] : [JSON.stringify(messageIds)])) as SourceRow[]
}

function localDate(format: Intl.DateTimeFormat, sentAtMs: bigint | null): string | null {
  if (sentAtMs === null || !Number.isFinite(new Date(Number(sentAtMs)).getTime())) return null
  const parts = format.formatToParts(Number(sentAtMs))
  if (parts.find(part => part.type === 'era')?.value !== 'AD') return null
  const year = parts.find(part => part.type === 'year')!.value.padStart(4, '0')
  if (year.length > 4) return null
  return [year, parts.find(part => part.type === 'month')!.value, parts.find(part => part.type === 'day')!.value].join('-')
}

function selectInsightSources(db: Store['reader'], conversationId: bigint, scope: InsightScope) {
  const timezone = scope.kind === 'dates' ? scope.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone
  const all = insightRows(db, conversationId)
  let selected = all
  if (scope.kind === 'dates') {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'gregory', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
    selected = all.filter(row => {
      const date = localDate(format, row.sent_at_ms)
      return date !== null && date >= scope.startDate && date <= scope.endDate
    })
  }
  let sourceStartTimeMs: number | null = null, sourceEndTimeMs: number | null = null
  for (const row of selected) {
    if (row.sent_at_ms === null) continue
    sourceStartTimeMs ??= Number(row.sent_at_ms)
    sourceEndTimeMs = Number(row.sent_at_ms)
  }
  const analyzable = selected.filter(row => row.kind !== 'system' && row.text.trim())
  const snapshotMaxId = selected.reduce((max, row) => row.id > max ? row.id : max, 0n).toString()
  const preview: InsightScopePreview = { scope, timezone, totalMessages: selected.length, analyzableMessages: analyzable.length, sourceStartTimeMs, sourceEndTimeMs }
  return { preview, analyzable, conversationMessages: all.length, snapshotMaxId }
}

export function previewInsightScope(db: Store['reader'], conversationId: bigint, scope: InsightScope): InsightScopePreview {
  return selectInsightSources(db, conversationId, scope).preview
}

export function captureInsightSources(db: Store['reader'], conversationId: bigint, scope: InsightScope) {
  const { preview, analyzable, conversationMessages, snapshotMaxId } = selectInsightSources(db, conversationId, scope)
  const sources = analyzable.map(row => {
    const { id, revision, originalRevision } = sourceMessage(row)
    return { messageId: id, revision, originalRevision }
  })
  const sourceTextBytes = analyzable.reduce((bytes, row) => bytes + Buffer.byteLength(row.text), 0)
  return { ...preview, conversationMessages, snapshotMaxId, sources, sourceTextBytes }
}

export function readCurrentInsightSources(db: Store['reader'], conversationId: bigint, messageIds: readonly string[]): InsightSourceMessage[] {
  return insightRows(db, conversationId, messageIds).map(row => {
    const { originalRevision: _originalRevision, ...message } = sourceMessage(row)
    return message
  })
}

export function readInsightCitationIds(
  db: Store['reader'], conversationId: bigint, snapshot: StoredInsightSnapshot, refs: readonly InsightSourceRef[],
): string[] | null {
  if (!refs.length) return null
  const ids = new Set(refs.map(source => source.messageId))
  if (ids.size !== refs.length) return null
  const cited = snapshot.sources.filter(source => ids.has(source.messageId))
  const frozen = new Map(cited.map(source => [source.messageId, source]))
  const current = new Map(insightRows(db, conversationId, [...ids]).map(row => {
    const source = sourceMessage(row)
    return [source.id, source.originalRevision]
  }))
  if (refs.some(source => {
    const saved = frozen.get(source.messageId)
    const original = current.get(source.messageId)
    return !saved || !original || saved.revision !== source.revision || original !== saved.originalRevision
  })) return null
  return cited.map(source => source.messageId)
}

export function readInsightSources(snapshot: InsightSnapshot, messageIds: readonly string[], current: readonly InsightSourceMessage[]): InsightSourceMessage[] {
  const revisions = new Map(snapshot.sources.map(source => [source.messageId, source.revision]))
  const currentById = new Map(current.map(message => [message.id, message]))
  return messageIds.map(messageId => {
    const message = currentById.get(messageId)
    if (!message || message.revision !== revisions.get(messageId)) {
      throw new BoundaryError('INVALID_INSIGHT_SOURCE', '请选择仍可查看的原文。')
    }
    return message
  })
}
