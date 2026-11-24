import { expect, test } from 'vitest'
import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { addInsightCoverage, createInsightReader } from '../../electron/main/insight-reader'
import type { InsightCoverage, InsightReadMessage, InsightReadSpan } from '../../src/shared/insight-reader'

const messages: InsightSourceMessage[] = Array.from({ length: 8 }, (_, index) => ({
  id: String(index + 10), revision: 'r' + index, memberId: 'private-member-key',
  senderName: index % 2 ? '乙' : '甲', isSelf: index % 2 === 0, sentAtMs: 100 + index,
  text: index === 0 ? '聚会总是我在张罗' : index === 6 ? '上个月是我安排的' : '核对聚会时间',
  replyToMessageId: index === 6 ? '10' : index === 1 ? '9' : null,
}))
const snapshot: InsightSnapshot = {
  taskId: '32', scope: { kind: 'all' }, timezone: 'UTC', createdAtMs: 0,
  sourceStartTimeMs: null, sourceEndTimeMs: null,
  sources: messages.map(({ id, revision }) => ({ messageId: id, revision })),
}
const read = async (ids: readonly string[]) => ids.map(id => messages.find(message => message.id === id)!)

test('远距离回复可定位前文，范围外回复不提供编号，回查不改变通读位置', async () => {
  const tool = createInsightReader(snapshot, read)
  const first = await tool({}, 380)
  expect(first.page.status).toBe('ok')
  if (first.page.status !== 'ok') throw new Error('缺少第一页')
  const firstIds = first.page.messages.map(message => message.id)
  expect(firstIds[0]).toBe('10')
  expect(first.page.nextCursor).toEqual(expect.any(String))
  const later = await tool({ messageId: '16' }, 1000)
  expect(later.page).toMatchObject({ messages: [{ id: '16', text: '上个月是我安排的', replyToMessageId: '10' }], nextCursor: null })
  const back = await tool({ messageId: '10', before: 1, after: 1 }, 1000)
  expect(back.page).toMatchObject({ messages: [{ id: '10', text: '聚会总是我在张罗' }, { id: '11', replyToMessageId: null }] })
  expect(JSON.stringify(back.page)).not.toContain('private-member-key')
  const next = await tool({ cursor: first.page.nextCursor! }, 8000)
  expect(next.page.status).toBe('ok')
  if (next.page.status === 'ok') expect([...firstIds, ...next.page.messages.map(message => message.id)]).toEqual(messages.map(message => message.id))
  expect((await tool({ messageId: '9' }, 1000)).page.status).toBe('out_of_scope')
})

test('超长脱敏原话可完整拼接，重启后只有所有分片成功提交才累计一条', async () => {
  const protectedText = '📅再核对[邮箱]'.repeat(42)
  const tool = createInsightReader(snapshot, async ids => (await read(ids)).map(m => ({ ...m, text: protectedText })))
  const parts: InsightReadMessage[] = []
  const spans: InsightReadSpan[] = []
  let cursor: string | null = null
  do {
    const next = await tool(cursor ? { cursor } : { messageId: '16' }, 260)
    if (next.page.status !== 'ok') throw new Error(next.page.status)
    expect(Buffer.byteLength(JSON.stringify(next.page))).toBeLessThanOrEqual(260)
    parts.push(...next.page.messages)
    spans.push(...next.spans)
    cursor = next.page.nextCursor
  } while (cursor)
  expect(parts.length).toBeGreaterThan(2)
  expect(parts.every(part => part.text.isWellFormed())).toBe(true)
  expect(parts.map(part => part.text).join('')).toBe(protectedText)
  let coverage: InsightCoverage = { coveredMessageIds: [], partial: {} }
  coverage = addInsightCoverage(coverage, [spans.at(-1)!, spans.at(-1)!])
  expect(coverage.coveredMessageIds).toEqual([])
  coverage = addInsightCoverage(JSON.parse(JSON.stringify(coverage)), spans.slice(1, -1))
  expect(coverage.coveredMessageIds).toEqual([])
  coverage = addInsightCoverage(coverage, [spans[0]])
  expect(coverage).toEqual({ coveredMessageIds: ['16'], partial: {} })
  expect(addInsightCoverage(coverage, spans)).toEqual(coverage)
})

test('原文失效时保留前面的一页，错误位置和越界编号不增加覆盖', async () => {
  const requested: string[] = []
  const tool = createInsightReader(snapshot, async ids => {
    requested.push(...ids)
    if (ids.includes('12')) throw Object.assign(new Error('原文变化'), { code: 'INVALID_INSIGHT_SOURCE' })
    return read(ids)
  })
  const first = await tool({}, 2000)
  if (first.page.status !== 'ok') throw new Error(first.page.status)
  expect(first.page.messages.map(message => message.id)).toEqual(['10', '11'])
  expect(await tool({ cursor: first.page.nextCursor! }, 2000)).toMatchObject({ page: { status: 'source_changed' }, spans: [] })
  expect(await tool({ cursor: '999.0.0.8' }, 2000)).toMatchObject({ page: { status: 'invalid_request' }, spans: [] })
  expect(await tool({ messageId: '9' }, 2000)).toMatchObject({ page: { status: 'out_of_scope' }, spans: [] })
  expect(requested).not.toContain('9')
  expect(await tool({ messageId: '13' }, 1)).toMatchObject({ page: { status: 'insufficient_capacity' }, spans: [] })
  expect((await tool({ messageId: '13' }, 500)).spans).toEqual([{ messageId: '13', start: 0, end: 6, length: 6 }])
})
