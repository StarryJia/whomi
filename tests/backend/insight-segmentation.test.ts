import { expect, test } from 'vitest'
import type { InsightSourceMessage } from '../../src/shared/conversation-insights'
import { insightSegmentTokenBudget, planInsightSegments } from '../../electron/main/insight-segmentation'
import { estimateTranscriptTokens, formatInsightTranscript } from '../../electron/main/insight-transcript'

const hour = 3600_000
const samples = (count: number, time: (i: number) => number | null): InsightSourceMessage[] =>
  Array.from({ length: count }, (_, i) => ({ id: String(10000 + i), revision: 'r', senderName: '甲', isSelf: true,
    sentAtMs: time(i), text: '一二三四五六七八九十'.repeat(4), replyToMessageId: null }))
const tokens = (messages: InsightSourceMessage[], timezone = 'UTC') => estimateTranscriptTokens(formatInsightTranscript(messages, timezone))

test('空快照没有时段；一条或恰好放得下整段时保留全部消息', () => {
  expect(planInsightSegments([], 'UTC', 1)).toEqual([])
  const messages = samples(12, i => i * 24 * hour)
  for (const batch of [messages.slice(0, 1), messages]) {
    const budget = tokens(batch)
    expect(planInsightSegments(batch, 'UTC', budget)).toEqual([{ index: 0, startIndex: 0, endIndex: batch.length - 1,
      startMessageId: batch[0].id, endMessageId: batch.at(-1)!.id, startTimeMs: batch[0].sentAtMs,
      endTimeMs: batch.at(-1)!.sentAtMs, estimatedTokens: budget, messageCount: batch.length }])
  }
})

test('换日本地时间优先于更长的同日间隔，日期按快照时区计算', () => {
  const base = Date.parse('2026-03-12T15:03:00Z')
  const messages = samples(18, i => base + i * 60_000 + (i >= 7 ? 49 * 60_000 : 0))
  const utc = planInsightSegments(messages, 'UTC', tokens(messages.slice(0, 11)))
  const shanghai = planInsightSegments(messages, 'Asia/Shanghai', tokens(messages.slice(0, 11), 'Asia/Shanghai'))
  expect(utc[0].messageCount).toBe(7)
  expect(shanghai[0].messageCount).toBe(8)
})

test('同日中优先选择至少六小时的间隔，时间相同或未知时在预算边缘切分', () => {
  const messages = samples(20, i => i * 1000 + (i >= 7 ? 6 * hour : 0) + (i >= 9 ? 2 * hour : 0))
  expect(planInsightSegments(messages, 'UTC', tokens(messages.slice(0, 10)))[0].messageCount).toBe(7)
  for (const stamp of [null, 0]) {
    const undated = samples(18, i => i % 2 ? null : stamp)
    const [first] = planInsightSegments(undated, 'UTC', tokens(undated.slice(0, 10)))
    expect(first).toMatchObject({ messageCount: 10, startTimeMs: stamp, endTimeMs: null })
  }
})

test('一条超长消息独占时段并继续处理后续原话', () => {
  const messages = samples(5, i => i)
  messages[2].text = '超长发言'.repeat(12000)
  const plans = planInsightSegments(messages, 'UTC', tokens(messages.slice(0, 2)))
  expect(plans.map(p => [p.startIndex, p.endIndex])).toEqual([[0, 1], [2, 2], [3, 4]])
  expect(plans[1].estimatedTokens).toBe(tokens(messages.slice(2, 3)))
})

test('指令与前段证据占用输入预算；即使提供大窗口也均分五千条连续消息且每段不超过 24000 词元', () => {
  expect(insightSegmentTokenBudget(128000, 2000)).toBe(24000)
  expect(insightSegmentTokenBudget(8000, 1000)).toBeLessThan(7000)
  const messages = samples(5000, i => i * 1000).map(m => ({ ...m, text: '我们来核对时间' }))
  const plans = planInsightSegments(messages, 'UTC', 128000)
  expect(plans.length).toBeGreaterThanOrEqual(3)
  expect(plans.length).toBeLessThanOrEqual(4)
  const counts = plans.map(x => x.messageCount)
  expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(1.3)
  let next = 0
  for (const [i, p] of plans.entries()) {
    expect(p).toMatchObject({ index: i, startIndex: next, endIndex: next + p.messageCount - 1,
      startMessageId: messages[next].id, endMessageId: messages[p.endIndex].id })
    expect(p.estimatedTokens).toBe(tokens(messages.slice(next, p.endIndex + 1)))
    expect(p.estimatedTokens).toBeLessThanOrEqual(24000)
    next = p.endIndex + 1
  }
  expect(next).toBe(5000)
})
