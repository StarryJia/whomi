import { expect, test } from 'vitest'
import { generatePiInsight, type PiInsightCheckpoint } from '../../electron/main/pi-insight-generation'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'
import type { InsightRuntimeCallbacks } from '../../electron/agent/protocol'
import type { InsightReadSpan } from '../../src/shared/insight-reader'
import { sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'

const sources = Array.from({ length: 4 }, (_, index) => ({ id: String(11 + index), revision: 'a'.repeat(64),
  text: '周三一起约。', senderName: '本人', isSelf: true, sentAtMs: index, replyToMessageId: null }))
const snapshot = { taskId: '7', scope: { kind: 'all' as const }, timezone: 'UTC', sourceStartTimeMs: null, sourceEndTimeMs: null,
  createdAtMs: 0, sources: sources.map(({ id, revision }) => ({ messageId: id, revision })) }
const options = { snapshot, conversationId: '2', thinkingLevel: undefined, prompts: defaultInsightPrompts, processing: defaultProcessing,
  checkpoint: null, signal: new AbortController().signal, operation: aiOperation(undefined, 'insight', 'generate'),
  model: { id: 'm', model: 'local', label: '本机模拟', baseUrl: 'http://localhost', enabled: true, hasCredential: false,
    version: 1, contextWindow: 16000, maxTokens: 800 },
  read: async (ids: readonly string[]) => sources.filter(source => ids.includes(source.id)) }
const section = [{ content: [{ text: '一起约', citationId: 'c' }] }]
const draft = { aboutYou: section, relationship: section, citations: [{ id: 'c', fragments: [{ messageIds: ['11'] }] }],
  limitations: [], judgments: sampleJudgments() }
const cursorFrom = (prompt: string) => /"resumeCursor":"([^"]+)"/.exec(prompt)![1]

async function infer(io: InsightRuntimeCallbacks, requestId: string, spans: InsightReadSpan[], checkpoint = requestId) {
  await io.record({ type: 'requestStart', requestId, kind: 'inference' })
  await io.record({ type: 'request', requestId, kind: 'inference', spans, success: true,
    stopReason: 'stop', usage: { inputTokens: 20, outputTokens: 5 }, checkpoint })
}

test.each([0, 1])('已送阅 %i 条时，多次提前结束仍按新增进度继续并完成同一报告', async initial => {
  let saved: PiInsightCheckpoint | undefined
  const checkpoint: PiInsightCheckpoint | null = initial ? {
    version: 'pi-insight-v1', taskId: snapshot.taskId, checkpoint: 'old-leaf', processing: defaultProcessing,
    coverage: { coveredMessageIds: ['11'], partial: {} }, requests: 5, stalled: 0, input: 100, output: 25,
  } : null
  let turns = 0
  const report = await generatePiInsight({ ...options, checkpoint, save: async state => { saved = structuredClone(state) },
    run: async (input, io) => {
      const index = initial + turns++
      expect(index).toBeLessThan(sources.length)
      expect(input.checkpoint).toBe(turns === 1 ? checkpoint?.checkpoint ?? null : 'stop-' + (turns - 1))
      expect(cursorFrom(input.prompt)).toBe('7.' + index + '.0.4')
      if (turns > 1) expect(input.prompt).toContain('尚有未读原文')
      const page = await io.read({ messageId: sources[index].id, before: 0, after: 0 }, 1000)
      await infer(io, 'read-' + turns, page.spans)
      // 一轮中已有进展，最后一次回复本身可以不带新范围。
      await infer(io, 'stop-' + turns, [])
      return { text: index === sources.length - 1 ? JSON.stringify(draft) : '继续阅读下一页。',
        checkpoint: 'stop-' + turns, usage: {} }
    } })
  expect(turns).toBe(4 - initial)
  expect(report.aboutYou).toEqual(section)
  expect(saved).toMatchObject({ taskId: '7', coverage: { coveredMessageIds: ['11', '12', '13', '14'], partial: {} },
    requests: (initial ? 5 : 0) + turns * 2, input: (initial ? 100 : 0) + turns * 40, report: { aboutYou: section } })
})

test('长消息完整条数不变但分片持续送阅时，仍可多次补读至成稿', async () => {
  const longSource = { ...sources[0], text: sources[0].text.repeat(40) }
  let saved: PiInsightCheckpoint | undefined
  let turns = 0
  const progress: number[] = []
  const report = await generatePiInsight({ ...options, snapshot: { ...snapshot, sources: snapshot.sources.slice(0, 1) },
    read: async () => [longSource], save: async state => { saved = structuredClone(state) }, run: async (input, io) => {
      expect(++turns).toBeLessThan(20)
      const page = await io.read({ cursor: cursorFrom(input.prompt) }, 320)
      expect(page.page.status).toBe('ok')
      await infer(io, 'fragment-' + turns, page.spans)
      progress.push(saved!.coverage.coveredMessageIds.length)
      return { text: saved!.coverage.coveredMessageIds.length ? JSON.stringify(draft) : '继续读取剩余原文。',
        checkpoint: 'fragment-' + turns, usage: {} }
    } })
  expect(turns).toBeGreaterThan(3)
  expect(progress.slice(0, 3)).toEqual([0, 0, 0])
  expect(saved!.coverage).toEqual({ coveredMessageIds: ['11'], partial: {} })
  expect(report.aboutYou).toEqual(section)
})

test.each(['repeat', 'compaction'])('补读只有 %s 而没有新增送阅范围时停止并保留断点', async kind => {
  let saved: PiInsightCheckpoint | undefined
  let turns = 0
  await expect(generatePiInsight({ ...options, save: async state => { saved = structuredClone(state) }, run: async (_, io) => {
    expect(++turns).toBeLessThan(3)
    const page = await io.read({ messageId: turns === 2 && kind === 'compaction' ? '12' : '11', before: 0, after: 0 }, 1000)
    if (turns === 2 && kind === 'compaction') {
      await io.record({ type: 'requestStart', requestId: 'summary', kind: 'compaction' })
      await io.record({ type: 'request', requestId: 'summary', kind: 'compaction', success: true,
        spans: page.spans, usage: {}, checkpoint: 'summary' })
      await infer(io, 'stop-2', [])
    } else await infer(io, 'read-' + turns, page.spans)
    return { text: '尚未完成。', checkpoint: 'stop-' + turns, usage: {} }
  } })).rejects.toMatchObject({ code: 'ANALYSIS_INCOMPLETE' })
  expect(turns).toBe(2)
  expect(saved).toMatchObject({ checkpoint: 'stop-2', coverage: { coveredMessageIds: ['11'], partial: {} } })
})

test('持续推进的提前结束不会绕过原有请求保护上限', async () => {
  let saved: PiInsightCheckpoint | undefined
  let turns = 0
  const checkpoint: PiInsightCheckpoint = { version: 'pi-insight-v1', taskId: '7', checkpoint: 'leaf', processing: defaultProcessing,
    coverage: { coveredMessageIds: [], partial: {} }, requests: 0, stalled: 0, input: 0, output: 0,
    workload: { capacity: { contextWindow: 16000, maxInputTokens: 15200, maxTokens: 800,
      contextSource: 'configured', outputSource: 'configured' }, protection: { requests: 2, input: 100000, output: 100000 } } }
  await expect(generatePiInsight({ ...options, checkpoint, save: async state => { saved = structuredClone(state) }, run: async (_, io) => {
    const index = turns++
    const page = await io.read({ messageId: sources[index].id, before: 0, after: 0 }, 1000)
    await infer(io, 'read-' + turns, page.spans)
    return { text: '还有下一页。', checkpoint: 'read-' + turns, usage: {} }
  } })).rejects.toMatchObject({ code: 'INSIGHT_BUDGET_EXHAUSTED' })
  expect(saved).toMatchObject({ requests: 2, checkpoint: 'read-2', coverage: { coveredMessageIds: ['11', '12'] } })
})
