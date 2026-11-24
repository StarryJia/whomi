import { expect, test } from 'vitest'
import { sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'
import { generatePiInsight, type PiInsightCheckpoint } from '../../electron/main/pi-insight-generation'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'
import { insightWorkload } from '../../electron/main/pi-insight-capacity'
import type { InsightReadSpan } from '../../src/shared/insight-reader'
import type { InsightRuntimeCallbacks } from '../../electron/agent/protocol'

const snapshot = { taskId: '7', scope: { kind: 'all' as const }, timezone: 'UTC', sourceStartTimeMs: null, sourceEndTimeMs: null,
  createdAtMs: 0, sources: [{ messageId: '11', revision: 'a'.repeat(64) }] }
const options = { snapshot, conversationId: '2', thinkingLevel: undefined, prompts: defaultInsightPrompts, processing: defaultProcessing,
  checkpoint: null, signal: new AbortController().signal, operation: aiOperation(undefined, 'insight', 'generate'),
  model: { id: 'm', model: 'local', label: '本机模拟', baseUrl: 'http://localhost', enabled: true, hasCredential: false, version: 1, contextWindow: 16000, maxTokens: 800 },
  read: async () => [{ id: '11', revision: 'a'.repeat(64), text: '周三一起约。', senderName: '我', isSelf: true, sentAtMs: 0, replyToMessageId: null }] }
const section = [{ content: [{ text: '一起约', citationId: 'c' }] }]
const draft = { aboutYou: section, relationship: section, citations: [{ id: 'c', fragments: [{ messageIds: ['11'] }] }], limitations: [], judgments: sampleJudgments() }

test('官方模型按接口匹配容量，跨服务同名模型使用估值，保留手填长度', async () => {
  const configured = { ...options.model, model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1', contextWindow: null, maxTokens: null }
  const { capacity } = await insightWorkload(configured, snapshot, false)
  expect(capacity).toMatchObject({ contextWindow: 1050000, maxTokens: 128000, maxInputTokens: 922000, outputSource: 'catalog' })
  expect((await insightWorkload({ ...configured, baseUrl: 'http://localhost/v1' }, snapshot, false)).capacity)
    .toMatchObject({ contextWindow: 256000, maxInputTokens: 144000, maxTokens: 128000, outputSource: 'estimated' })
  expect((await insightWorkload({ ...configured, maxTokens: 32000, maxInputTokens: 100000 }, snapshot, false)).capacity)
    .toMatchObject({ maxTokens: 32000, maxInputTokens: 100000, outputSource: 'configured' })
  expect((await insightWorkload({ ...configured, contextWindow: 4096 }, snapshot, false)).capacity)
    .toMatchObject({ contextWindow: 4096, maxTokens: 2048, maxInputTokens: 2048 })
  for (const started of [false, true]) {
    expect((await insightWorkload({ ...configured, contextWindow: 16000, maxInputTokens: 12000 }, snapshot, started)).capacity)
      .toMatchObject({ contextWindow: 16000, maxTokens: 8000, maxInputTokens: 12000 })
    expect((await insightWorkload({ ...configured, maxInputTokens: 200000 }, snapshot, started)).capacity)
      .toMatchObject({ contextWindow: 1050000, maxTokens: 128000, maxInputTokens: 200000 })
  }
  const long = { ...snapshot, sourceTextBytes: 400000 }
  const existing = await insightWorkload(configured, long, true)
  expect(existing.protection.requests).toBeGreaterThan(101)
  expect(existing.capacity).toEqual(capacity)
})

test('从断点恢复时沿用独立输入与输出上限', async () => {
  const capacity = { contextWindow: 256000, maxInputTokens: 144000, maxTokens: 128000, contextSource: 'estimated', outputSource: 'estimated' } as const
  const checkpoint: PiInsightCheckpoint = {
    version: 'pi-insight-v1', taskId: snapshot.taskId, checkpoint: 'read', processing: defaultProcessing,
    coverage: { coveredMessageIds: ['11'], partial: {} }, requests: 1, stalled: 0, input: 50, output: 10,
    workload: { capacity, protection: { requests: 25, input: 3600000, output: 3200000 } },
  }
  await generatePiInsight({ ...options, checkpoint, save: async () => {}, run: async input => {
    expect(input.model).toMatchObject({ contextWindow: 256000, maxInputTokens: 144000, maxTokens: 128000 })
    return { text: JSON.stringify(draft), checkpoint: 'done', usage: {} }
  } })
})

test('提前交稿和坏引用可在同一会话修正，重试保存沿用已校验的正文', async () => {
  let saved: PiInsightCheckpoint | null = null
  const save = async (state: PiInsightCheckpoint) => { saved = structuredClone(state) }
  const requests: (string | null | undefined)[] = []
  const badDraft = { ...draft, citations: [{ id: 'c', fragments: [{ messageIds: ['12'] }] }] }
  await expect(generatePiInsight({ ...options, save, run: async (input, io) => {
    requests.push(input.checkpoint)
    if (requests.length === 1) return { text: JSON.stringify(draft), checkpoint: 'first', usage: {} }
    if (requests.length === 3) {
      expect(input.prompt).toContain('引用')
      return { text: JSON.stringify(badDraft), checkpoint: 'bad-report', usage: {} }
    }
    expect(input.prompt).toContain('resumeCursor')
    const page = await io.read({}, 2000)
    await io.record({ type: 'requestStart', requestId: 'r', kind: 'inference' })
    await io.record({ type: 'request', requestId: 'r', kind: 'inference', spans: page.spans, success: true, usage: { inputTokens: 100 }, checkpoint: 'second' })
    return { text: JSON.stringify(badDraft), checkpoint: 'bad-report', usage: {} }
  } })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(requests).toEqual([null, 'first', 'bad-report'])
  expect(saved).toMatchObject({ coverage: { coveredMessageIds: ['11'] }, input: 100, checkpoint: 'bad-report' })
  const fixed = await generatePiInsight({ ...options, checkpoint: saved, save, run: async input => {
    expect(input.checkpoint).toBe('bad-report')
    expect(input.prompt).toContain('已完整送阅')
    return { text: JSON.stringify(draft), checkpoint: 'corrected', usage: {} }
  } })
  expect(fixed.aboutYou).toEqual(section)
  expect(await generatePiInsight({ ...options, checkpoint: saved, save, run: () => { throw Error('unexpected model request') } })).toEqual(fixed)
})

test.each([1, 2, 20])('完整送阅后循环核查 %i 处，只有新增范围才推进', async distinct => {
  const refs = Array.from({ length: 20 }, (_, i) => ({ messageId: String(11 + i), revision: 'a'.repeat(64) }))
  const run = generatePiInsight({ ...options, snapshot: { ...snapshot, sources: refs },
    read: async ids => ids.map(id => ({ id, revision: refs[0].revision, text: '合成原文。', senderName: '本人', isSelf: true, sentAtMs: 0, replyToMessageId: null })),
    save: async () => {}, run: async (_input, io) => {
      const page = await io.read({}, 10000)
      const start = (id: string) => io.record({ type: 'requestStart', requestId: id, kind: 'inference' })
      // 工具已取到整页时，下一次推理还没有确认收到这些原文。
      await io.record({ type: 'requestStart', requestId: 'summary', kind: 'compaction' })
      await io.record({ type: 'request', requestId: 'summary', kind: 'compaction', spans: page.spans, success: true, usage: {}, checkpoint: 'summary' })
      await start('failed')
      await io.record({ type: 'request', requestId: 'failed', kind: 'inference', spans: page.spans, success: false, usage: {}, checkpoint: 'summary' })
      expect(await start('first')).toBeUndefined()
      expect(await io.record({ type: 'request', requestId: 'first', kind: 'inference', spans: page.spans, success: true, usage: {}, checkpoint: 'all' })).toEqual({ fullyReviewed: refs.length })
      expect(await io.record({ type: 'checkpoint', checkpoint: 'all' })).toEqual({ fullyReviewed: refs.length })
      for (let i = 0; i < refs.length; i++) {
        const review = await io.read({ messageId: refs[i % distinct].messageId, before: 0, after: 0 }, 500)
        const id = 'review' + i
        expect(await start(id)).toEqual({ fullyReviewed: refs.length })
        await io.record({ type: 'request', requestId: id, kind: 'inference', spans: review.spans, success: true, usage: {}, checkpoint: 'all' })
      }
      return { text: JSON.stringify(draft), checkpoint: 'done', usage: {} }
    } })
  if (distinct < refs.length) await expect(run).rejects.toMatchObject({ code: 'INSIGHT_NO_PROGRESS' })
  else await expect(run).resolves.toMatchObject({ aboutYou: section })
})

test('恢复已落盘的回查片段时，只有成功送达的新范围才解除停滞', async () => {
  let saved: PiInsightCheckpoint = { version: 'pi-insight-v1', taskId: '7', checkpoint: 'read', processing: defaultProcessing,
    requests: 1, stalled: 0, input: 10, output: 2, coverage: { coveredMessageIds: ['11'], partial: {} },
    reviewCoverage: { coveredMessageIds: [], partial: { '11': [[0, 3]] } } }
  const save = async (state: PiInsightCheckpoint) => { saved = structuredClone(state) }
  const history = { messageId: '11', start: 0, end: 6, length: 6 }
  let pending: InsightReadSpan[] = []
  const record = async (io: InsightRuntimeCallbacks, requestId: string, spans: InsightReadSpan[], kind: 'inference' | 'compaction' = 'inference', success = true) => {
    await io.record({ type: 'requestStart', requestId, kind })
    await io.record({ type: 'request', requestId, kind, success, spans, usage: {}, checkpoint: saved.checkpoint })
  }
  await expect(generatePiInsight({ ...options, checkpoint: saved, save, run: async (_, io) => {
    for (let i = 0; i < 15; i++) await record(io, 'history' + i, [history])
    pending = (await io.read({ cursor: '7.0.3.1' }, 500)).spans
    await io.record({ type: 'checkpoint', checkpoint: 'pending-tool' })
    throw new Error('暂停')
  } })).rejects.toThrow('暂停')
  expect(saved).toMatchObject({ checkpoint: 'pending-tool', stalled: 15, reviewCoverage: { coveredMessageIds: [], partial: { '11': [[0, 3]] } } })
  await generatePiInsight({ ...options, checkpoint: saved, save, run: async (_, io) => {
    await record(io, 'compact', pending, 'compaction')
    await record(io, 'failed', pending, 'inference', false)
    expect(saved.stalled).toBe(15)
    await record(io, 'replay', [history, ...pending])
    expect(saved).toMatchObject({ stalled: 0, reviewCoverage: { coveredMessageIds: ['11'], partial: {} } })
    await record(io, 'repeated', pending)
    expect(saved.stalled).toBe(1)
    return { text: JSON.stringify(draft), checkpoint: 'done', usage: {} }
  } })
})

test('超长原文恢复从已确认的连续前缀之后取文', async () => {
  const checkpoint: PiInsightCheckpoint = { version: 'pi-insight-v1', taskId: '7', checkpoint: 'leaf', processing: defaultProcessing,
    requests: 2, stalled: 0, input: 60, output: 3, coverage: { coveredMessageIds: [], partial: { '11': [[0, 2], [4, 5]] } } }
  await expect(generatePiInsight({ ...options, checkpoint, save: async () => {}, run: async (input, io) => {
    const { resumeCursor } = JSON.parse(input.prompt.slice(input.prompt.indexOf('{')))
    const result = await io.read({ cursor: resumeCursor }, 2000)
    expect(result.page).toMatchObject({ status: 'ok', messages: [{ text: '一起约。', fragment: { start: 2 } }] })
    throw new Error('模拟服务离线')
  } })).rejects.toThrow('模拟服务离线')
})

test('依据与反例逐条匹配送阅原话，交叉引用的摘录须重新提交', async () => {
  const other = { messageId: '12', revision: 'b'.repeat(64) }
  const scoped = { ...snapshot, sources: [...snapshot.sources, other] }
  const messages = [...await options.read(), { id: other.messageId, revision: other.revision, text: '到了再决定。', senderName: '对方', isSelf: false, sentAtMs: 1, replyToMessageId: null }]
  const checkpoint: PiInsightCheckpoint = { version: 'pi-insight-v1', taskId: '7', checkpoint: 'read', processing: defaultProcessing,
    requests: 1, stalled: 0, input: 60, output: 3, coverage: { coveredMessageIds: ['11', '12'], partial: {} } }
  let attempts = 0
  const report = await generatePiInsight({ ...options, snapshot: scoped, checkpoint, save: async () => {},
    read: async ids => messages.filter(message => ids.includes(message.id)), run: async () => {
      attempts++
      const text = attempts === 1 ? '到了再决定' : '周三一起约'
      const judgments = sampleJudgments({ JP: { direction: 'J', text: '你说「' + text + '」，其中「一起约」给了对方选择。对方说「到了再决定」。',
        supportingIds: ['11'], counterexampleIds: ['12'], excerpts: [{ messageId: '11', text }, { messageId: '11', text: '一起约' }, { messageId: '12', text: '到了再决定' }] } })
      return { text: JSON.stringify({ ...draft, judgments }), checkpoint: 'draft', usage: {} }
    } })
  expect(attempts).toBe(2)
  expect(report.judgments?.at(-1)).toMatchObject({
    supportingSources: [{ messageId: '11', excerpts: ['周三一起约', '一起约'] }], counterexampleSources: [{ messageId: '12', excerpts: ['到了再决定'] }],
  })
})
