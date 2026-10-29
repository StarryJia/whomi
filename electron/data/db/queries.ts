import type { Store } from './open'
import { confirmedSelfSql } from './self'
import type { ConversationQueries, ConversationSummary, MessagePage, MessagePosition, MessageView, ReplyView } from '../../../src/shared/desktop-api'

const maxId = 9223372036854775807n
type Anchor = { id: bigint; time_bucket: bigint; sort_time: bigint }
type MessageRow = Anchor & {
  conversation_id: bigint; member_id: bigint | null; sender_kind: MessageView['senderKind']; sender_name: string
  sent_at_ms: bigint | null; time_raw: string | null; time_precision: MessageView['timePrecision']; timezone: string | null
  ordinal: bigint; kind: MessageView['kind']; source_type: string | null; text: string
}
type Cursor = { version: 1; kind: 'messages' | 'conversations'; id: string; size: number; conversationId?: string; snapshotMaxId?: string; bucket?: number; time?: number }
function invalid(): never { throw Object.assign(new Error('读取位置无效，请刷新后重试。'), { code: 'INVALID_CURSOR' }) }
function id(value: unknown, zero = false): bigint {
  if (typeof value !== 'string' || value.length > 19 || !(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)) invalid()
  const result = BigInt(value)
  if (result > maxId) invalid()
  return result
}
function integer(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) invalid()
  return result
}
function timestamp(value: bigint | null): number | null { return value === null ? null : integer(value) }
function size(value: unknown = 100): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) invalid()
  return value
}
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url') }
function decode(value: unknown, kind: Cursor['kind']): Cursor {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid()
  let cursor: Cursor
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) invalid()
    cursor = JSON.parse(bytes.toString('utf8'))
  } catch { invalid() }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || cursor.version !== 1 || cursor.kind !== kind) invalid()
  const keys = kind === 'messages' ? ['version', 'kind', 'id', 'size', 'conversationId', 'snapshotMaxId', 'bucket', 'time'] : ['version', 'kind', 'id', 'size']
  if (Object.keys(cursor).length !== keys.length || Object.keys(cursor).some(key => !keys.includes(key))) invalid()
  id(cursor.id); size(cursor.size)
  if (kind === 'messages') {
    id(cursor.conversationId); const snapshot = id(cursor.snapshotMaxId)
    if (id(cursor.id) > snapshot || (cursor.bucket !== 0 && cursor.bucket !== 1) || !Number.isSafeInteger(cursor.time) || (cursor.bucket === 1 && cursor.time !== 0)) invalid()
  }
  return cursor
}
function pageSize(limit: unknown, cursor?: Cursor) {
  const result = size(limit === undefined ? cursor?.size : limit)
  if (cursor && result !== cursor.size) invalid()
  return result
}
function compare(left: Anchor, right: Anchor): number {
  for (const key of ['time_bucket', 'sort_time', 'id'] as const) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  return 0
}
function position(row: Anchor): MessagePosition { return { id: String(row.id), timeBucket: integer(row.time_bucket) as 0 | 1, sortTime: integer(row.sort_time) } }

export function createQueries(store: Store): ConversationQueries {
  const db = store.reader
  const self = db.prepare(`SELECT ${confirmedSelfSql} AS confirmed FROM memberships m WHERE m.conversation_id=? AND m.id=?`)
  function snapshot(conversationId: bigint): bigint {
    return (db.prepare('SELECT coalesce(max(id),0) AS id FROM messages WHERE conversation_id=?').get(conversationId) as { id: bigint }).id
  }
  function anchor(conversationId: bigint, messageId: bigint): Anchor | undefined {
    return db.prepare('SELECT id,time_bucket,sort_time FROM messages WHERE conversation_id=? AND id=?').get(conversationId, messageId) as Anchor | undefined
  }
  function messageCursor(conversationId: bigint, row: Anchor, snapshotMaxId: bigint, count: number): string {
    return encode({ version: 1, kind: 'messages', conversationId: String(conversationId), id: String(row.id), bucket: integer(row.time_bucket), time: integer(row.sort_time), snapshotMaxId: String(snapshotMaxId), size: count })
  }
  function range(conversationId: bigint, snapshotMaxId: bigint, boundary: Anchor | undefined, direction: 'before' | 'after', count: number, inclusive = false): MessageRow[] {
    const operator = direction === 'before' ? '<' : '>'
    const order = direction === 'before' ? 'DESC' : 'ASC'
    const condition = boundary ? ` AND (m.time_bucket,m.sort_time,m.id) ${operator}${inclusive ? '=' : ''} (?,?,?)` : ''
    return db.prepare(`SELECT m.* FROM messages m WHERE m.conversation_id=? AND m.id<=?${condition}
      ORDER BY m.time_bucket ${order},m.sort_time ${order},m.id ${order} LIMIT ?`).all(conversationId, snapshotMaxId, ...(boundary ? [boundary.time_bucket, boundary.sort_time, boundary.id] : []), count) as MessageRow[]
  }
  function has(conversationId: bigint, snapshotMaxId: bigint, boundary: Anchor, direction: 'before' | 'after'): boolean {
    return db.prepare(`SELECT 1 FROM messages WHERE conversation_id=? AND id<=? AND (time_bucket,sort_time,id) ${direction === 'before' ? '<' : '>'} (?,?,?) LIMIT 1`).get(conversationId, snapshotMaxId, boundary.time_bucket, boundary.sort_time, boundary.id) !== undefined
  }
  function view(row: MessageRow): MessageView {
    const reply = db.prepare('SELECT target_message_id,original_id,id_namespace,text,sender_name,sent_at_ms,state FROM message_replies WHERE message_id=? AND conversation_id=?').get(row.id, row.conversation_id) as { target_message_id: bigint | null; original_id: string | null; id_namespace: string | null; text: string | null; sender_name: string | null; sent_at_ms: bigint | null; state: ReplyView['state'] } | undefined
    const attachments = db.prepare('SELECT kind,name,state FROM message_attachments WHERE message_id=? ORDER BY id').all(row.id) as MessageView['attachments']
    const isSelf = row.member_id !== null && (self.get(row.conversation_id, row.member_id) as { confirmed: bigint } | undefined)?.confirmed === 1n
    return {
      id: String(row.id), conversationId: String(row.conversation_id), memberId: row.member_id === null ? null : String(row.member_id),
      senderKind: row.sender_kind, senderName: row.sender_name, isSelf, sentAtMs: timestamp(row.sent_at_ms), timeRaw: row.time_raw,
      timePrecision: row.time_precision, timezone: row.timezone, timeBucket: integer(row.time_bucket) as 0 | 1, sortTime: integer(row.sort_time),
      ordinal: integer(row.ordinal), kind: row.kind, sourceType: row.source_type, text: row.text,
      reply: reply ? { targetMessageId: reply.target_message_id === null ? null : String(reply.target_message_id), originalId: reply.original_id, idNamespace: reply.id_namespace, text: reply.text, senderName: reply.sender_name, sentAtMs: timestamp(reply.sent_at_ms), state: reply.state } : null,
      attachments,
    }
  }
  function page(conversationId: bigint, snapshotMaxId: bigint, rows: MessageRow[], count: number): MessagePage {
    return {
      items: rows.map(view), snapshotMaxId: String(snapshotMaxId),
      beforeCursor: rows.length && has(conversationId, snapshotMaxId, rows[0], 'before') ? messageCursor(conversationId, rows[0], snapshotMaxId, count) : null,
      afterCursor: rows.length && has(conversationId, snapshotMaxId, rows[rows.length - 1], 'after') ? messageCursor(conversationId, rows[rows.length - 1], snapshotMaxId, count) : null,
    }
  }
  return {
    async listConversations(input) {
      const cursor = input.cursor === undefined ? undefined : decode(input.cursor, 'conversations'), count = pageSize(input.limit, cursor)
      return db.transaction(() => {
        const rows = db.prepare(`SELECT c.id,c.title,c.kind,coalesce(s.message_count,0) AS message_count,coalesce(s.member_count,0) AS member_count,
          s.first_sent_at_ms,s.last_sent_at_ms,coalesce(s.status,'pending') AS summary_status
          FROM conversations c LEFT JOIN conversation_summaries s ON s.conversation_id=c.id ${cursor ? 'WHERE c.id<?' : ''} ORDER BY c.id DESC LIMIT ?`).all(...(cursor ? [id(cursor.id)] : []), count + 1) as { id: bigint; title: string; kind: ConversationSummary['kind']; message_count: bigint; member_count: bigint; first_sent_at_ms: bigint | null; last_sent_at_ms: bigint | null; summary_status: ConversationSummary['summaryStatus'] }[]
        const more = rows.length > count
        const items = rows.slice(0, count).map(row => ({ id: String(row.id), title: row.title, kind: row.kind, messageCount: integer(row.message_count), memberCount: integer(row.member_count), firstSentAtMs: timestamp(row.first_sent_at_ms), lastSentAtMs: timestamp(row.last_sent_at_ms), summaryStatus: row.summary_status }))
        return { items, nextCursor: more ? encode({ version: 1, kind: 'conversations', id: items[items.length - 1].id, size: count }) : null }
      })()
    },
    async readMessages(input) {
      const conversationId = id(input.conversationId)
      if (input.direction !== 'before' && input.direction !== 'after') invalid()
      const cursor = input.cursor === undefined ? undefined : decode(input.cursor, 'messages'), count = pageSize(input.limit, cursor)
      if (cursor && cursor.conversationId !== input.conversationId) invalid()
      return db.transaction(() => {
        const current = snapshot(conversationId), snapshotMaxId = cursor ? id(cursor.snapshotMaxId) : current
        let boundary: Anchor | undefined
        if (cursor) {
          boundary = anchor(conversationId, id(cursor.id))
          if (!boundary || snapshotMaxId > current || boundary.time_bucket !== BigInt(cursor.bucket!) || boundary.sort_time !== BigInt(cursor.time!)) invalid()
        }
        const rows = range(conversationId, snapshotMaxId, boundary, input.direction, count)
        if (input.direction === 'before') rows.reverse()
        return page(conversationId, snapshotMaxId, rows, count)
      })()
    },
    async locateSource(input) {
      const conversationId = id(input.conversationId), startId = id(input.messageId), endId = id(input.endMessageId ?? input.messageId)
      return db.transaction(() => {
        const start = anchor(conversationId, startId), end = anchor(conversationId, endId)
        if (!start || !end || compare(start, end) > 0) return { status: 'unavailable' as const }
        const snapshotMaxId = snapshot(conversationId)
        const before = range(conversationId, snapshotMaxId, start, 'before', 20).reverse()
        const after = range(conversationId, snapshotMaxId, start, 'after', 80, true)
        return { status: 'available' as const, conversationId: String(conversationId), startMessageId: String(startId), endMessageId: String(endId), start: position(start), end: position(end), page: page(conversationId, snapshotMaxId, [...before, ...after], 100), rangeEndCursor: messageCursor(conversationId, end, snapshotMaxId, 100) }
      })()
    },
  }
}
