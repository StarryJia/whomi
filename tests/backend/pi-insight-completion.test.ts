import { expect, onTestFinished, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'
import { generatePiInsight, type PiInsightCheckpoint } from '../../electron/main/pi-insight-generation'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'
import { createOperationDiagnostics } from '../../electron/main/operation-diagnostics'
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

async function openLog() {
  const root = await mkdtemp(join(tmpdir(), 'whomi-insight-log-'))
  const log = createOperationDiagnostics(root, '1.0.0')
  onTestFinished(async () => { await log.close(); await rm(root, { recursive: true, force: true }) })
  const operation = aiOperation(log, 'insight', 'generate')
  operation.bind(snapshot.taskId, 0)
  return { operation, contents: () => log.withFile(operation.id!, file => readFile(file, 'utf8')) }
}

test('普通操作日志能从容量不足的回查追到重试取得的目标和成功报告', async () => {
  const { operation, contents } = await openLog()
  await generatePiInsight({ ...options, operation, save: async () => {}, run: async (_, io) => {
    async function infer(id: string, spans: InsightReadSpan[]) {
      await io.record({ type: 'requestStart', requestId: id, kind: 'inference' })
      await io.record({ type: 'request', requestId: id, kind: 'inference', spans, success: true, usage: {}, checkpoint: 'leaf' })
    }
    await infer('fixture-private-first', [])
    const target = { messageId: '11' }
    await io.read(target, 1, 'fixture-private-first')
    await infer('fixture-private-second', [])
    const page = await io.read(target, 500, 'fixture-private-second')
    await infer('fixture-private-final', page.spans)
    return { text: JSON.stringify(draft), checkpoint: 'done', usage: {} }
  } })
  operation.end('success')
  const text = await contents()
  const reads = text.split('\n').filter(line => line.includes('取文方式='))
  expect(reads[0]).toContain('请求序号=1')
  expect(reads[0]).toContain('找到目标=否')
  expect(reads[1]).toContain('请求序号=2')
  expect(reads[1]).toContain('上次容量不足的请求序号=1')
  expect(reads[1]).toContain('找到目标=是')
  expect(text).toContain('结果=成功')
  expect(text).not.toContain('fixture-private')
})

test('续页取得此前容量不足的多个定位目标，每个目标只关联一次', async () => {
  const { operation, contents } = await openLog()
  const [base] = await options.read()
  const sources = ['11', '12', '13'].map(id => ({ ...base, id, text: base.text.repeat(20) }))
  await generatePiInsight({ ...options, operation, snapshot: { ...snapshot, sources: sources.map(({ id, revision }) => ({ messageId: id, revision })) },
    read: async ids => sources.filter(source => ids.includes(source.id)), save: async () => {}, run: async (_, io) => {
      async function infer(requestId: string, spans: InsightReadSpan[] = []) {
        await io.record({ type: 'requestStart', requestId, kind: 'inference' })
        await io.record({ type: 'request', requestId, kind: 'inference', success: true, spans, usage: {}, checkpoint: 'leaf' })
      }
      await infer('first')
      await io.read({ messageId: '12' }, 1, 'first')
      await infer('second')
      await io.read({ messageId: '13', before: 2 }, 1, 'second')
      await infer('retry')
      const first = await io.read({ messageId: '13', before: 2 }, 250, 'retry')
      expect(first.spans.map(span => span.messageId)).toEqual(['11'])
      if (first.page.status !== 'ok' || !first.page.nextCursor) throw Error('测试页缺少续读游标')
      await infer('continue', first.spans)
      const next = await io.read({ cursor: first.page.nextCursor }, 1000, 'continue')
      expect(next.spans.map(span => span.messageId)).toEqual(['12', '13'])
      await infer('repeat', next.spans)
      await io.read({ cursor: first.page.nextCursor }, 1000, 'repeat')
      return { text: JSON.stringify(draft), checkpoint: 'done', usage: {} }
    } })
  const text = await contents()
  expect(text).toMatch(/按编号定位.*定位序号=3.*找到目标=否.*请求序号=3.*上次容量不足的请求序号=2/)
  const recovered = text.split('\n').filter(line => line.includes('阶段=已取到此前容量不足的目标'))
  expect(recovered).toHaveLength(2)
  expect(recovered[0]).toMatch(/定位序号=2.*请求序号=4.*上次容量不足的请求序号=1/)
  expect(recovered[1]).toMatch(/定位序号=3.*请求序号=4.*上次容量不足的请求序号=2/)
})

test('本地容量预检阻止压缩时，本次失败记录不引用前一条成功回执', async () => {
  const { operation, contents } = await openLog()
  const updates: Record<string, unknown>[] = []
  await expect(generatePiInsight({ ...options, operation, onDiagnostic: fields => updates.push(fields), save: async () => {},
    run: async (_, io) => {
      await io.record({ type: 'requestStart', kind: 'inference', requestId: 'prior' })
      await io.record({ type: 'request', kind: 'inference', requestId: 'prior', success: true, stopReason: 'toolUse',
        responseReceived: true, httpStatus: 200, spans: [], usage: {}, checkpoint: 'leaf' })
      await io.record({ type: 'requestBlocked', kind: 'compaction', code: 'MODEL_CONTEXT_LIMIT' })
      throw new Error('本地容量不足')
    } })).rejects.toThrow('本地容量不足')
  expect(updates.at(-1)).toEqual({ phase: 'compaction', kind: 'compaction', code: 'MODEL_CONTEXT_LIMIT' })
  const line = (await contents()).split('\n').find(row => row.includes('请求未发出'))
  expect(line).toContain('MODEL_CONTEXT_LIMIT')
  expect(line).not.toMatch(/请求序号|服务状态码|收到服务响应/)
})

test('普通操作日志分别记录压缩结束原因和摘要是否保存，即使用量相同', async () => {
  const { operation, contents } = await openLog()
  const diagnostics: Record<string, unknown>[] = []
  await expect(generatePiInsight({ ...options, operation, onDiagnostic: fields => diagnostics.push(fields),
    save: async () => {}, run: async (_, io) => {
      for (const [id, reason, saved] of [['a', 'length', false], ['b', 'stop', true], ['c', undefined, false]] as const) {
        await io.record({ type: 'requestStart', requestId: id, kind: 'compaction' })
        await io.record({ type: 'request', requestId: id, kind: 'compaction', success: true, stopReason: reason,
          spans: [], usage: { outputTokens: 4000 }, checkpoint: 'leaf' })
        await io.record({ type: 'summary', requestId: id, saved })
      }
      await io.record({ type: 'requestStart', requestId: 'd', kind: 'inference' })
      await io.record({ type: 'request', requestId: 'd', kind: 'inference', success: false, stopReason: 'error',
        failureCode: 'INSIGHT_REQUEST_INCOMPATIBLE', httpStatus: 400, responseReceived: true, spans: [], usage: {}, checkpoint: 'leaf' })
      throw new Error('模拟服务拒绝')
    } })).rejects.toThrow('模拟服务拒绝')
  expect(diagnostics.at(-1)).toMatchObject({ phase: 'reading', requestNumber: 4, code: 'INSIGHT_REQUEST_INCOMPATIBLE', responseReceived: true, httpStatus: 400 })
  const text = await contents()
  const rows = text.split('\n').filter(line => line.includes('结束原因='))
  expect(rows[0]).toContain('结束原因=达到输出上限')
  expect(rows[1]).toContain('结束原因=正常结束')
  expect(rows[2]).toContain('结束原因=原因未知')
  const summaries = text.split('\n').filter(line => line.includes('摘要已保存='))
  expect(summaries).toHaveLength(3)
  expect(summaries[0]).toMatch(/请求序号=1.*摘要已保存=否/)
  expect(summaries[1]).toMatch(/请求序号=2.*摘要已保存=是/)
  expect(text).toContain('错误码=INSIGHT_REQUEST_INCOMPATIBLE')
  expect(text).toMatch(/处理建议=.*调整模型接口或参数设置.*重新开始洞察/)
})

test.each([true, false])('交稿后压缩时，报告校验与保存沿用推理请求序号（稿件有效=%s）', async valid => {
  const diagnostics: Record<string, unknown>[] = []
  let attempt = 0
  let savedWith: unknown
  const run = generatePiInsight({ ...options, onDiagnostic: fields => diagnostics.push(fields),
    save: async state => { if (state.report) savedWith = diagnostics.at(-1)?.requestNumber },
    run: async (_, io) => {
      const reportId = 'report-' + ++attempt
      const summaryId = 'summary-' + attempt
      const page = await io.read({}, 500)
      await io.record({ type: 'requestStart', kind: 'inference', requestId: reportId })
      await io.record({ type: 'request', kind: 'inference', requestId: reportId, success: true, stopReason: 'stop',
        spans: page.spans, usage: {}, checkpoint: 'leaf' })
      await io.record({ type: 'requestStart', kind: 'compaction', requestId: summaryId })
      await io.record({ type: 'request', kind: 'compaction', requestId: summaryId, success: true, stopReason: 'stop',
        spans: [], usage: {}, checkpoint: 'leaf' })
      await io.record({ type: 'summary', requestId: summaryId, saved: true })
      return { text: valid ? JSON.stringify(draft) : '{}', checkpoint: 'done', usage: {} }
    } })
  if (valid) {
    await expect(run).resolves.toMatchObject({ aboutYou: section })
    expect(savedWith).toBe(1)
  } else {
    await expect(run).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  }
  expect(diagnostics.filter(fields => fields.phase === 'writing').map(fields => fields.requestNumber)).toEqual(valid ? [1] : [1, 3])
  expect(diagnostics.filter(fields => fields.summarySaved === true).map(fields => fields.requestNumber)).toEqual(valid ? [2] : [2, 4])
})

test('断点恢复后原文仍未送阅时，保护记录未读数量和实际触发值', async () => {
  const { operation, contents } = await openLog()
  const checkpoint: PiInsightCheckpoint = {
    version: 'pi-insight-v1', taskId: snapshot.taskId, checkpoint: 'leaf', processing: defaultProcessing,
    coverage: { coveredMessageIds: [], partial: {} }, requests: 16, stalled: 16, input: 200, output: 50,
  }
  await expect(generatePiInsight({ ...options, operation, checkpoint, save: async () => {}, run: async (_, io) => {
    await io.record({ type: 'requestStart', requestId: 'next', kind: 'inference' })
    throw new Error('unexpected request')
  } })).rejects.toMatchObject({ code: 'INSIGHT_NO_PROGRESS', action: expect.stringContaining('还有1条原文未读完') })
  const text = await contents()
  expect(text).toContain('恢复前累计请求数=16')
  expect(text).toMatch(/触发阅读停滞保护.*尚有未读原文，阅读未推进.*数量=16.*限额=16.*累计已读=0/)
})

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
  const { operation, contents } = await openLog()
  const refs = Array.from({ length: 20 }, (_, i) => ({ messageId: String(11 + i), revision: 'a'.repeat(64) }))
  const diagnostics: Record<string, unknown>[] = []
  const run = generatePiInsight({ ...options, operation, snapshot: { ...snapshot, sources: refs }, onDiagnostic: fields => diagnostics.push(fields),
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
  if (distinct < refs.length) {
    await expect(run).rejects.toMatchObject({ code: 'INSIGHT_NO_PROGRESS', action: expect.stringContaining('回查') })
    expect(diagnostics.at(-1)).toMatchObject({ phase: 'checking', rule: 'noNewReviewRange', count: 16, limit: 16, readCount: 20 })
    const text = await contents()
    expect(text).toMatch(/触发阅读停滞保护.*已读完，回查未增加范围.*数量=16.*限额=16/)
    expect(text).toContain('处理建议=请继续洞察')
  } else {
    await expect(run).resolves.toMatchObject({ aboutYou: section })
    operation.end('success')
    const text = await contents()
    expect(text).toMatch(/按编号定位.*任务阶段=回查.*定位序号=20.*找到目标=是/)
    expect(text).toContain('结果=成功')
    expect(text).not.toContain('触发阅读停滞保护')
  }
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
    expect(result.page).toMatchObject({ status: 'ok', transcript: expect.stringContaining('11 00:00 我 [片段 2-6/6]: 一起约。') })
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


test('更换到小窗口模型重新计算容量并保留累计用量、阅读覆盖和原会话断点', async () => {
  const oldWorkload = await insightWorkload(options.model, snapshot, false)
  const checkpoint: PiInsightCheckpoint = { version: 'pi-insight-v1', taskId: snapshot.taskId, checkpoint: 'old-session-leaf',
    processing: defaultProcessing, coverage: { coveredMessageIds: ['11'], partial: {} }, requests: 7, input: 50000, output: 8000, stalled: 3, workload: oldWorkload }
  let saved: PiInsightCheckpoint | undefined
  const replacement = { ...options.model, id: 'new-provider', contextWindow: 8000, maxInputTokens: 6000, maxTokens: 1000 }
  const report = await generatePiInsight({ ...options, model: replacement, modelSessionKey: 'new-provider-1', checkpoint,
    save: async state => { saved = structuredClone(state) }, run: async (input, io) => {
      expect(input.checkpoint).toBe('old-session-leaf')
      expect(input.model).toMatchObject({ id: 'new-provider', contextWindow: 8000, maxInputTokens: 6000, maxTokens: 1000 })
      expect(input.insightSession?.modelSessionKey).toBe('new-provider-1')
      expect(input.prompt).toContain('完整送阅')
      await io.record({ type: 'requestStart', requestId: 'new-request', kind: 'inference' })
      await io.record({ type: 'request', requestId: 'new-request', kind: 'inference', success: true, spans: [], usage: { totalInputTokens: 100, outputTokens: 10 }, checkpoint: 'new-leaf' })
      return { text: JSON.stringify(draft), checkpoint: 'new-leaf', usage: {} }
    } })
  expect(report.citations).toHaveLength(1)
  expect(saved).toMatchObject({ requests: 8, coverage: { coveredMessageIds: ['11'] }, modelSessionKey: 'new-provider-1' })
  expect(saved!.workload!.protection.input).toBeGreaterThan(50000)
  expect(saved!.input).toBeGreaterThanOrEqual(50100)
})
