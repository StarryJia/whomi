import { afterEach, expect, test } from 'vitest'
import { openStore, type Store } from '../../electron/data/db/open'
import { createQueries } from '../../electron/data/db/queries'
import { rebuildSummary } from '../../electron/data/import/summary'
import { temporaryStore } from './helpers'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture() {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanups.push(() => { store.close(); temp.cleanup() })
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'示例会话','direct',0),(2,'另一会话','group',0)")
  return { store, queries: createQueries(store) }
}
function add(store: Store, times: (number | null)[], conversationId = 1n, startId?: bigint) {
  const insert = store.writer.prepare("INSERT INTO messages(id,conversation_id,sender_kind,sender_name,sent_at_ms,time_raw,time_precision,kind,text,ordinal) VALUES (?,?,'unknown','示例发送者',?,'原始时间','second','text',?,?)")
  return store.writer.transaction(() => times.map((time, index) => String(insert.run(startId === undefined ? null : startId + BigInt(index), conversationId, time, `示例消息 ${index}`, index).lastInsertRowid)))()
}
function changed(cursor: string, patch: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), ...patch })).toString('base64url')
}

test('pages 250 equal timestamps exactly once in either direction', async () => {
  const { store, queries } = fixture(); const ids = add(store, Array(250).fill(123))
  const first = await queries.readMessages({ conversationId: '1', direction: 'after' })
  const second = await queries.readMessages({ conversationId: '1', direction: 'after', cursor: first.afterCursor! })
  const third = await queries.readMessages({ conversationId: '1', direction: 'after', cursor: second.afterCursor! })
  expect([first, second, third].map(page => page.items.length)).toEqual([100, 100, 50])
  expect([first, second, third].flatMap(page => page.items.map(item => item.id))).toEqual(ids)
  expect(third.afterCursor).toBeNull(); expect(first.beforeCursor).toBeNull()
  const backwards = await queries.readMessages({ conversationId: '1', direction: 'before', cursor: second.beforeCursor! })
  expect(backwards.items.map(item => item.id)).toEqual(ids.slice(0, 100))
  const latest = await queries.readMessages({ conversationId: '1', direction: 'before' })
  expect(latest.items.map(item => item.id)).toEqual(ids.slice(150))
})

test('excludes new backfill from both directions until refresh and reads committed data only', async () => {
  const { store, queries } = fixture(); add(store, Array.from({ length: 230 }, (_, i) => i))
  const first = await queries.readMessages({ conversationId: '1', direction: 'after' })
  const [backfill] = add(store, [-1])
  const second = await queries.readMessages({ conversationId: '1', direction: 'after', cursor: first.afterCursor! })
  const back = await queries.readMessages({ conversationId: '1', direction: 'before', cursor: second.beforeCursor! })
  expect(second.snapshotMaxId).toBe('230'); expect(back.items.some(item => item.id === backfill)).toBe(false)
  expect((await queries.readMessages({ conversationId: '1', direction: 'after' })).items[0].id).toBe(backfill)
  store.writer.exec('BEGIN'); add(store, [-2])
  try { expect((await queries.readMessages({ conversationId: '1', direction: 'after' })).snapshotMaxId).toBe(backfill) } finally { store.writer.exec('ROLLBACK') }
  expect(store.reader.inTransaction).toBe(false)
})

test('keeps unknown times in source order after negative and zero times', async () => {
  const { store, queries } = fixture(); add(store, [null, 0, -1, null])
  const first = await queries.readMessages({ conversationId: '1', direction: 'after', limit: 2 })
  const second = await queries.readMessages({ conversationId: '1', direction: 'after', cursor: first.afterCursor! })
  expect(first.items.map(item => [item.id, item.sentAtMs, item.timeBucket])).toEqual([['3', -1, 0], ['2', 0, 0]])
  expect(second.items.map(item => [item.id, item.ordinal, item.timeBucket, item.timeRaw, item.timePrecision])).toEqual([['1', 0, 1, '原始时间', 'second'], ['4', 3, 1, '原始时间', 'second']])
})

test('rejects cross-conversation, malformed, oversized and inconsistent page inputs', async () => {
  const { store, queries } = fixture(); add(store, Array(3).fill(0)); add(store, [0], 2n)
  const page = await queries.readMessages({ conversationId: '1', direction: 'after', limit: 1 }), cursor = page.afterCursor!
  await expect(queries.readMessages({ conversationId: '2', direction: 'after', cursor })).rejects.toThrow()
  for (const invalid of ['?', 'a'.repeat(2049), changed(cursor, { version: 2 }), changed(cursor, { snapshotMaxId: '9223372036854775808' }), changed(cursor, { snapshotMaxId: '0' }), changed(cursor, { id: '01' }), changed(cursor, { bucket: 2 }), changed(cursor, { time: 1 }), changed(cursor, { size: 201 }), changed(cursor, { conversationId: '2' })]) {
    await expect(queries.readMessages({ conversationId: '1', direction: 'after', cursor: invalid })).rejects.toThrow()
  }
  for (const limit of [0, -1, 201, 1.5, NaN]) await expect(queries.readMessages({ conversationId: '1', direction: 'after', limit })).rejects.toThrow()
  for (const conversationId of ['01', '-1', '9007199254740993.0', '9223372036854775808']) await expect(queries.readMessages({ conversationId, direction: 'after' })).rejects.toThrow()
  await expect(queries.readMessages({ conversationId: '1', direction: 'after', cursor, limit: 2 })).rejects.toThrow()
  store.writer.exec('DELETE FROM messages WHERE id=1')
  await expect(queries.readMessages({ conversationId: '1', direction: 'after', cursor })).rejects.toThrow()
})

test('locates message 12000 directly with 20 preceding and 79 following messages', async () => {
  const { store, queries } = fixture(); add(store, Array.from({ length: 13000 }, (_, i) => i))
  const source = await queries.locateSource({ conversationId: '1', messageId: '12000', endMessageId: '12500' })
  expect(source.status).toBe('available')
  if (source.status !== 'available') throw new Error('source unavailable')
  expect(source.page.items).toHaveLength(100); expect(source.page.items[0].id).toBe('11980'); expect(source.page.items[20].id).toBe('12000'); expect(source.page.items[99].id).toBe('12079')
  expect(source.startMessageId).toBe('12000'); expect(source.endMessageId).toBe('12500')
  expect(source.start).toEqual({ id: '12000', timeBucket: 0, sortTime: 11999 }); expect(source.end).toEqual({ id: '12500', timeBucket: 0, sortTime: 12499 })
  const next = await queries.readMessages({ conversationId: '1', direction: 'after', cursor: source.page.afterCursor! })
  expect(next.items[0].id).toBe('12080'); expect(next.snapshotMaxId).toBe(source.page.snapshotMaxId)
  const end = await queries.readMessages({ conversationId: '1', direction: 'before', cursor: source.rangeEndCursor, limit: 100 })
  expect(end.items.at(-1)?.id).toBe('12499')
})

test('returns unavailable for missing, deleted, cross-conversation and reversed endpoints', async () => {
  const { store, queries } = fixture(); add(store, [0, 1]); add(store, [0], 2n)
  for (const input of [{ conversationId: '1', messageId: '3' }, { conversationId: '1', messageId: '1', endMessageId: '3' }, { conversationId: '1', messageId: '1', endMessageId: '999' }, { conversationId: '1', messageId: '2', endMessageId: '1' }]) expect(await queries.locateSource(input)).toEqual({ status: 'unavailable' })
  store.writer.exec('DELETE FROM messages WHERE id=1')
  expect(await queries.locateSource({ conversationId: '1', messageId: '1' })).toEqual({ status: 'unavailable' })
})

test('preserves large identifiers and source ranges crossing the unknown time segment', async () => {
  const { store, queries } = fixture(); store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (9007199254740993,'大编号示例','direct',0)")
  const ids = add(store, [-1, 0, null, null], 9007199254740993n, 9007199254740993n)
  const source = await queries.locateSource({ conversationId: '9007199254740993', messageId: ids[0], endMessageId: ids[3] })
  expect(source.status).toBe('available')
  if (source.status !== 'available') throw new Error('source unavailable')
  expect(source.page.items.map(item => item.id)).toEqual(ids); expect(source.page.snapshotMaxId).toBe('9007199254740996')
  expect(JSON.parse(JSON.stringify(source)).startMessageId).toBe('9007199254740993')
  expect(source.end).toEqual({ id: '9007199254740996', timeBucket: 1, sortTime: 0 })
  const first = await queries.readMessages({ conversationId: '9007199254740993', direction: 'after', limit: 2 })
  const second = await queries.readMessages({ conversationId: '9007199254740993', direction: 'after', cursor: first.afterCursor! })
  expect(second.items.map(item => item.id)).toEqual(['9007199254740995', '9007199254740996'])
  expect(await queries.locateSource({ conversationId: '9007199254740993', messageId: ids[3], endMessageId: ids[1] })).toEqual({ status: 'unavailable' })
})

test('lists summaries by descending exact id with stable bounded pages', async () => {
  const { store, queries } = fixture(); add(store, [-1, 0, null]); await rebuildSummary(store, '1')
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (9007199254740993,'大编号示例','direct',0); INSERT INTO conversation_summaries(conversation_id,status) VALUES (2,'failed')")
  const first = await queries.listConversations({ limit: 2 })
  expect(first.items.map(item => item.id)).toEqual(['9007199254740993', '2']); expect(first.items.map(item => item.summaryStatus)).toEqual(['pending', 'failed'])
  store.writer.exec("INSERT INTO conversations(title,kind,created_at_ms) VALUES ('新会话','direct',0)")
  const second = await queries.listConversations({ cursor: first.nextCursor! })
  expect(second.items).toEqual([expect.objectContaining({ id: '1', title: '示例会话', messageCount: 3, memberCount: 0, firstSentAtMs: -1, lastSentAtMs: 0, summaryStatus: 'ready' })]); expect(second.nextCursor).toBeNull()
  await expect(queries.listConversations({ cursor: changed(first.nextCursor!, { id: '01' }) })).rejects.toThrow()
  await expect(queries.listConversations({ limit: 201 })).rejects.toThrow()
})

test('reads sending-time names, confirmed self, replies and inert attachment descriptions', async () => {
  const { store, queries } = fixture(); store.writer.exec("INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES (1,1,'test','test'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES (1,1,1,'a','新名字'); INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,1,'candidate','parser'); INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES (1,1,1,'member','发送时名字','reply',' 原文\\n',0); INSERT INTO message_replies(message_id,conversation_id,text,sender_name) VALUES (1,1,'引用摘要','示例对象'); INSERT INTO message_attachments(message_id,kind,locator,name,state) VALUES (1,'image','C:/private/example.png','example.png','unresolved')")
  let page = await queries.readMessages({ conversationId: '1', direction: 'after' })
  expect(page.items[0]).toMatchObject({ senderName: '发送时名字', isSelf: false, kind: 'reply', text: ' 原文\\n', reply: { targetMessageId: null, originalId: null, idNamespace: null, text: '引用摘要', state: 'unresolved' }, attachments: [{ kind: 'image', name: 'example.png', state: 'unresolved' }] })
  expect(page.items[0].attachments[0]).not.toHaveProperty('locator')
  store.writer.exec("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,1,'confirmed','user')")
  page = await queries.readMessages({ conversationId: '1', direction: 'after' }); expect(page.items[0].isSelf).toBe(true)
  store.writer.exec('INSERT INTO self_opt_outs VALUES (1)')
  expect((await queries.readMessages({ conversationId: '1', direction: 'after' })).items[0].isSelf).toBe(false)
})

test('uses conversation read index without a temporary whole-message sort', async () => {
  const { store, queries } = fixture(); add(store, [0, 0, null])
  const plans: string[] = [], prepare = store.reader.prepare.bind(store.reader)
  const spy = store.reader.prepare
  store.reader.prepare = ((sql: string) => {
    if (/SELECT m\.\*/.test(sql)) {
      const stmt = prepare(`EXPLAIN QUERY PLAN ${sql}`)
      const original = prepare(sql), all = original.all.bind(original)
      original.all = ((...params: unknown[]) => { plans.push(...(stmt.all(...params) as { detail: string }[]).map(row => row.detail)); return all(...params) }) as typeof original.all
      return original
    }
    return prepare(sql)
  }) as typeof store.reader.prepare
  try {
    const page = await queries.readMessages({ conversationId: '1', direction: 'after', limit: 1 })
    await queries.readMessages({ conversationId: '1', direction: 'after', cursor: page.afterCursor! })
    await queries.locateSource({ conversationId: '1', messageId: '2' })
  } finally { store.reader.prepare = spy }
  expect(plans.length).toBeGreaterThan(0); expect(plans.some(detail => detail.includes('messages_read_order'))).toBe(true)
  expect(plans.some(detail => /TEMP B-TREE.*ORDER BY/i.test(detail))).toBe(false)
})

test('bounds full pages at 200 and handles empty, first and last source context', async () => {
  const { store, queries } = fixture()
  expect(await queries.readMessages({ conversationId: '1', direction: 'after' })).toEqual({ items: [], beforeCursor: null, afterCursor: null, snapshotMaxId: '0' })
  add(store, Array(250).fill(0))
  expect((await queries.readMessages({ conversationId: '1', direction: 'after', limit: 200 })).items).toHaveLength(200)
  const first = await queries.locateSource({ conversationId: '1', messageId: '1' }), last = await queries.locateSource({ conversationId: '1', messageId: '250' })
  expect(first.status).toBe('available'); expect(last.status).toBe('available')
  if (first.status !== 'available' || last.status !== 'available') throw new Error('source unavailable')
  expect(first.page.items).toHaveLength(80); expect(first.page.beforeCursor).toBeNull(); expect(first.startMessageId).toBe(first.endMessageId)
  expect(last.page.items).toHaveLength(21); expect(last.page.afterCursor).toBeNull()
})
