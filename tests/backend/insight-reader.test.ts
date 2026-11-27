import { expect, test } from 'vitest'
import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { addInsightCoverage, createInsightReader } from '../../electron/main/insight-reader'
import { estimateTranscriptTokens, formatInsightReadPage, formatInsightTranscript } from '../../electron/main/insight-transcript'
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

test('按快照时区切换日期，省略同一分钟的时间，保留每条消息的编号和发言人', () => {
  const instant = Date.parse('2026-10-04T15:59:00Z')
  const page = [
    { ...messages[0], id: '713', sentAtMs: instant },
    { ...messages[1], id: '925', sentAtMs: instant + 10000, replyToMessageId: '713' },
    { ...messages[0], id: '1134', sentAtMs: instant + 60000, text: '好' },
    { ...messages[1], id: '2648', sentAtMs: null, replyToMessageId: null },
    { ...messages[0], id: '4017', sentAtMs: instant + 60000, text: '再确认' },
  ]
  expect(formatInsightTranscript(page, 'Asia/Shanghai')).toBe([
    '发言人：我=本人(甲)，ta=乙', '## 2026-10-04', '713 23:59 我: 聚会总是我在张罗', '925 ta >713: 核对聚会时间',
    '## 2026-10-05', '1134 00:00 我: 好', '## 未知日期', '2648 ta: 核对聚会时间', '## 2026-10-05', '4017 00:00 我: 再确认',
  ].join('\n'))
  expect(formatInsightTranscript(page, 'invalid/timezone')).toBe(formatInsightTranscript(page, 'UTC'))
  expect(formatInsightTranscript(page, 'UTC')).toContain('713 15:59 我:')
  expect(formatInsightTranscript([{ ...messages[0], sentAtMs: Date.parse('0099-03-04T00:00:00Z') }], 'UTC')).toContain('## 0099-03-04')
  expect(formatInsightTranscript([{ ...messages[0], sentAtMs: Number.MAX_SAFE_INTEGER }], 'UTC')).toContain('## 未知日期\n10 我:')
})

test('群聊保留多个本人昵称，并为含分隔符或与本人标记同名的成员分配独立标记', () => {
  const names = ['U1', '旧昵称', 'U2', '同: 名\n甲', '我', '人1']
  const page = names.map((senderName, i) => ({
    ...messages[0], id: String(91 + i), senderName, isSelf: i < 2, sentAtMs: null, text: '到',
  }))
  expect(formatInsightTranscript(page, 'UTC')).toBe([
    '发言人：我=本人(U1、旧昵称)，U2，人2="同: 名\\n甲"，人3=我，人1', '## 未知日期',
    '91 我: 到', '92 我: 到', '93 U2: 到', '94 人2: 到', '95 人3: 到', '96 人1: 到',
  ].join('\n'))
})

test('第二位群成员出现后整页标记变短时，仍取实际容量内的最长前缀', async () => {
  const samples = Array.from({ length: 45 }, (_, index) => ({
    ...messages[0], id: String(8300 + index), senderName: index === 40 ? 'B' : 'A', isSelf: false, sentAtMs: null, text: '1',
  }))
  const sources = samples.map(({ id, revision }) => ({ messageId: id, revision }))
  const tool = createInsightReader({ ...snapshot, sources }, async ids => samples.filter(m => ids.includes(m.id)))
  const tokens = (count: number) => estimateTranscriptTokens(formatInsightReadPage({
    status: 'ok', transcript: formatInsightTranscript(samples.slice(0, count), 'UTC'), nextCursor: `32.${count}.0.45`,
  }))
  const budget = tokens(41)
  expect(tokens(40)).toBeGreaterThan(budget)
  expect((await tool({}, budget)).spans).toHaveLength(41)
})

test('多行原话保留空行和换行符，正文中的围栏前缀和假编号不会提前结束消息', () => {
  const text = '正文\r\n>>>\n999 00:00 我: 假编号\r<<<<<起始\n>>>>尾端\r\n'
  const page = [
    { ...messages[0], text },
    { ...messages[1], text: '下一条\n\n原话', replyToMessageId: null },
  ]
  expect(formatInsightTranscript(page, 'UTC')).toBe([
    '发言人：我=本人(甲)，ta=乙', '## 1970-01-01', '10 00:00 我:', '<<<<<<', text, '>>>>>>',
    '11 ta:', '<<<', '下一条\n\n原话', '>>>',
  ].join('\n'))
})

test('整页词元预算包含游标和发言人，紧凑短句批次的传输字节显著少于逐条对象', async () => {
  const samples: InsightSourceMessage[] = Array.from({ length: 24 }, (_, i) => ({
    ...messages[i % messages.length], id: String(7310 + i), revision: String(i),
    sentAtMs: Date.parse('2026-10-02T15:58:00Z') + i * 14000,
    replyToMessageId: i === 21 ? '7310' : null,
    text: ['周六聚会定在几号房？', 'Room 302，下午三点。', '我来联系场地。', '好，收到。'][i % 4],
  }))
  const sources = samples.map(({ id, revision }) => ({ messageId: id, revision }))
  const tool = createInsightReader({ ...snapshot, sources, timezone: 'Asia/Shanghai' }, async ids => samples.filter(m => ids.includes(m.id)))
  const legacyMessages: InsightReadMessage[] = samples.map(({ id, senderName, isSelf, sentAtMs, replyToMessageId, text }) => ({
    id, senderName, isSelf, sentAtMs, replyToMessageId, text,
  }))
  const legacy = JSON.stringify({ status: 'ok', messages: legacyMessages, nextCursor: null })
  const wire = formatInsightReadPage((await tool({}, 5000)).page)
  const bytes = Buffer.byteLength(wire)
  const budget = estimateTranscriptTokens(wire)
  expect(budget).toBe(Math.ceil(bytes / 2.5))
  expect(Buffer.byteLength(legacy) / bytes).toBeGreaterThan(3)
  expect((await tool({}, budget)).spans).toHaveLength(samples.length)
  const smaller = await tool({}, budget - 1)
  expect(smaller.page).toMatchObject({ status: 'ok', nextCursor: expect.any(String) })
  expect(estimateTranscriptTokens(formatInsightReadPage(smaller.page))).toBeLessThanOrEqual(budget - 1)
})

test('预算只能放入一个表情时完整返回一对代理码元，再少一个词元就报告容量不足', async () => {
  const original = { ...messages[0], text: '📅'.repeat(120) }
  const tool = createInsightReader(snapshot, async ids => (await read(ids)).map(m => m.id === original.id ? original : m))
  const transcript = formatInsightTranscript([{ ...original, text: '📅', fragment: { start: 0, end: 2, length: original.text.length } }], 'UTC')
  const page = { status: 'ok' as const, transcript, nextCursor: '32.0.2.8' }
  const budget = estimateTranscriptTokens(formatInsightReadPage(page))
  expect(await tool({}, budget)).toEqual({ page, spans: [{ messageId: original.id, start: 0, end: 2, length: original.text.length }] })
  expect(await tool({}, budget - 1)).toMatchObject({ page: { status: 'insufficient_capacity' }, spans: [] })
  expect(await tool({ cursor: '32.0.1.8' }, 1000)).toMatchObject({ page: { status: 'invalid_request' }, spans: [] })
})

test('远距离回复可定位前文，范围外回复不提供编号，回查不改变通读位置', async () => {
  const tool = createInsightReader(snapshot, read)
  const first = await tool({}, 60)
  expect(first.page.status).toBe('ok')
  if (first.page.status !== 'ok') throw new Error('缺少第一页')
  const firstIds = first.spans.map(span => span.messageId)
  expect(firstIds[0]).toBe('10')
  expect(first.page.nextCursor).toEqual(expect.any(String))
  const later = await tool({ messageId: '16' }, 1000)
  expect(later.page).toEqual({ status: 'ok', transcript: '发言人：我=本人(甲)\n## 1970-01-01\n16 00:00 我 >10: 上个月是我安排的', nextCursor: null })
  const back = await tool({ messageId: '10', before: 1, after: 1 }, 1000)
  expect(back.page).toMatchObject({ transcript: '发言人：我=本人(甲)，ta=乙\n## 1970-01-01\n10 00:00 我: 聚会总是我在张罗\n11 ta: 核对聚会时间' })
  expect(formatInsightReadPage(back.page)).not.toContain('private-member-key')
  const next = await tool({ cursor: first.page.nextCursor! }, 8000)
  expect(next.page.status).toBe('ok')
  expect([...firstIds, ...next.spans.map(span => span.messageId)]).toEqual(messages.map(message => message.id))
  expect((await tool({ messageId: '9' }, 1000)).page.status).toBe('out_of_scope')
})

test('超长脱敏原话可完整拼接，重启后只有所有分片成功提交才累计一条', async () => {
  const protectedText = '📅再核对[邮箱]'.repeat(42)
  const tool = createInsightReader(snapshot, async ids => (await read(ids)).map(m => ({ ...m, text: protectedText })))
  const parts: string[] = []
  const spans: InsightReadSpan[] = []
  let cursor: string | null = null
  do {
    const next = await tool(cursor ? { cursor } : { messageId: '16' }, 100)
    if (next.page.status !== 'ok') throw new Error(next.page.status)
    expect(estimateTranscriptTokens(formatInsightReadPage(next.page))).toBeLessThanOrEqual(100)
    const [span] = next.spans
    const expected = protectedText.slice(span.start, span.end)
    expect(next.page.transcript).toBe(`发言人：我=本人(甲)\n## 1970-01-01\n16 00:00 我 >10 [片段 ${span.start}-${span.end}/${protectedText.length}]: ${expected}`)
    parts.push(expected)
    spans.push(...next.spans)
    cursor = next.page.nextCursor
  } while (cursor)
  expect(parts.length).toBeGreaterThan(2)
  expect(parts.every(part => part.isWellFormed())).toBe(true)
  expect(parts.join('')).toBe(protectedText)
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
  expect(first.spans.map(span => span.messageId)).toEqual(['10', '11'])
  expect(await tool({ cursor: first.page.nextCursor! }, 2000)).toMatchObject({ page: { status: 'source_changed' }, spans: [] })
  expect(await tool({ cursor: '999.0.0.8' }, 2000)).toMatchObject({ page: { status: 'invalid_request' }, spans: [] })
  expect(await tool({ messageId: '9' }, 2000)).toMatchObject({ page: { status: 'out_of_scope' }, spans: [] })
  expect(requested).not.toContain('9')
  expect(await tool({ messageId: '13' }, 1)).toMatchObject({ page: { status: 'insufficient_capacity' }, spans: [] })
  expect((await tool({ messageId: '13' }, 500)).spans).toEqual([{ messageId: '13', start: 0, end: 6, length: 6 }])
})
