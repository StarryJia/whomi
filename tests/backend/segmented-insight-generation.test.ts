import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, onTestFinished, test, vi } from 'vitest'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { InsightEvidenceCard, InsightEvidenceCardRecord } from '../../electron/data/ai/insight-evidence-card'
import { assembleMethodologyPrompt } from '../../electron/data/ai/methodology'
import { createAiRepository } from '../../electron/data/ai/repository'
import { openStore } from '../../electron/data/db/open'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'
import { generateSegmentedInsight, type SegmentedInsightCheckpoint } from '../../electron/main/segmented-insight-generation'
import { insightWorkload } from '../../electron/main/pi-insight-capacity'
import { planInsightSegments } from '../../electron/main/insight-segmentation'
import { createInsightTraceWriter } from '../../electron/main/insight-trace'
import type { InsightRuntimeCallbacks } from '../../electron/agent/protocol'
import { sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'
import { temporaryStore } from './helpers'

const originals = ['这周我来约。', '周三可以。', '先看时间，再定。', '再不答应，我就把私聊发出去。', '这次交给你来约。', '那我来联系。']
const preference = '分清每次是谁联系。'
const sections = ['第一次约时间', '再议时间', '转交安排']

function evidence(index: number): InsightEvidenceCard {
  const first = String(index * 2 + 1), second = String(index * 2 + 2)
  return {
    period: sections[index],
    events: [{ summary: sections[index], options: '先约或再定', selfChoice: originals[index * 2],
      counterpartResponse: originals[index * 2 + 1], messageIds: [first, second] }],
    selfSignals: [{ dimension: 'JP', directionHint: null, observation: originals[index * 2],
      supportingIds: [first], counterexampleIds: [], excerpts: [{ messageId: first, text: originals[index * 2] }] }],
    riskSignals: index === 1 ? [{ fact: 'ta 表示会公开私聊。', messageIds: [second] }] : [],
    revisions: index ? [{ targetSegment: 0, kind: index === 1 ? 'added_context' : 'behavior_change',
      priorClaim: '第一次由本人联系。', revisedObservation: originals[index * 2], messageIds: ['1', first] }] : [],
    openThreads: [],
  }
}

function draft(early: boolean) {
  const ids = early ? ['1', '5'] : ['5']
  const cited = ids.map(id => ({ text: originals[Number(id) - 1], citationId: 'c' + id }))
  return { aboutYou: [{ content: cited }], relationship: [{ content: [{ text: '两人轮流联系。' }] }],
    citations: ids.map(id => ({ id: 'c' + id, fragments: [{ messageIds: [id] }] })), judgments: sampleJudgments() }
}

async function reply(io: InsightRuntimeCallbacks, requestId: string, body: unknown) {
  const usage = { inputTokens: 60, outputTokens: 10 }
  await io.record({ type: 'requestStart', kind: 'inference', requestId })
  await io.record({ type: 'request', kind: 'inference', requestId, success: true, spans: [], usage, checkpoint: requestId })
  return { text: JSON.stringify(body), usage, checkpoint: requestId }
}

async function setup(messageTexts = originals, replacementWindow = 16000) {
  const temp = temporaryStore()
  let store = openStore(temp.path)
  const connect = () => createAiRepository(store, async operation => operation())
  let db = connect()
  onTestFinished(() => { store.close(); temp.cleanup() })
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'排期','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name)
      VALUES(1,1,1,'me','本人'),(2,1,1,'peer','对方');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user')`)
  const insert = store.writer.prepare(`INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms)
    VALUES(?,1,?,'member',?,'text',?,?,?)`)
  messageTexts.forEach((original, i) => insert.run(i + 1, i % 2 + 1, i % 2 ? '对方' : '本人', original, i, i * 86400000))
  const model = { id: 'first', model: 'local', label: '本机模拟', baseUrl: 'http://localhost/v1', contextWindow: 32000, maxTokens: 1000, enabled: true }
  await db.saveModel(model, 'example')
  await db.saveModel({ ...model, id: 'replacement', contextWindow: replacementWindow }, 'example')
  const prepared = await db.prepareAnalysis({ conversationId: '1', modelId: 'first' })
  const task = await db.confirmAnalysis({ token: prepared.token, requestId: 'segment-test' })
  const taskId = task.id
  const read = async (messageIds: readonly string[]) => db.readInsightSources({ taskId, messageIds })
  const { snapshot } = db.analysisContext(taskId)
  const sources = await read(snapshot.sources.map(ref => ref.messageId))
  const segments = sections.map((_, index) => ({
    ...planInsightSegments(sources.slice(index * 2, index * 2 + 2), snapshot.timezone, 24000)[0],
    index, startIndex: index * 2, endIndex: index * 2 + 1,
  }))
  const operation = aiOperation(undefined, 'insight', 'generate')
  const events = vi.spyOn(operation, 'event')
  const writeTrace = createInsightTraceWriter(dirname(temp.path))
  const trace = async () => JSON.parse(await readFile(join(dirname(temp.path), 'ai-runtime', 'insight-traces', 'task-' + taskId + '.json'), 'utf8'))
  const commits: { coverage: number; card: InsightEvidenceCardRecord; receiptId?: string }[] = []
  const options = (): Omit<Parameters<typeof generateSegmentedInsight>[0], 'run'> => {
    const context = db.analysisContext(taskId)
    return { ...context, methodology: context.methodology!, editablePrompt: preference, thinkingLevel: undefined,
      checkpoint: context.checkpoint ? JSON.parse(context.checkpoint) : null, signal: new AbortController().signal, operation,
      processing: defaultProcessing, snapshot, conversationId: '1', read, segments, trace: writeTrace,
      listCards: async () => db.listInsightEvidenceCards(taskId),
      save: async (state, receipt, card) => {
        const saved = await db.saveInsightCheckpoint(taskId, JSON.stringify(state), state.coverage.coveredMessageIds, undefined, receipt, card)
        if (card) commits.push({ coverage: saved.analyzedMessages, card, receiptId: receipt?.requestId })
      },
    }
  }
  return { options, taskId, commits, events, trace, db: () => db, store: () => store,
    reopen() { store.close(); store = openStore(temp.path); db = connect() } }
}

test('逐段提交卡片、覆盖与回执，统一成稿可回查原话并补足早期依据', async () => {
  const f = await setup()
  const options = f.options()
  const requests: number[] = []
  let drafts = 0
  const report = await generateSegmentedInsight({ ...options, run: async (input, io) => {
    if (input.insightSession?.mode === 'segment') {
      const index = Number(input.prompt.match(/segmentIndex: (\d+)/)![1])
      requests.push(index)
      expect(input.checkpoint).toBeNull()
      expect(input.systemPrompt).toContain(options.methodology.methodology.body)
      expect(input.systemPrompt).toContain(preference)
      expect(input.prompt.split('transcript:\n')[1]).toContain(originals[index * 2])
      const prior = JSON.parse(input.prompt.match(/priorEvidenceCards: (.*)\n/)![1])
      expect(prior.map((card: InsightEvidenceCard) => card.period)).toEqual(sections.slice(0, index))
      const card = evidence(index)
      if (index === 1 && requests.filter(n => n === 1).length === 1) card.selfSignals[0].excerpts[0].text = '不存在的原话。'
      if (index === 2 && requests.filter(n => n === 2).length === 1) card.riskSignals.push({ fact: '其他会话', messageIds: ['3000'] })
      return reply(io, 'extract-' + requests.length, card)
    }
    drafts++
    expect(input.systemPrompt).toBe(assembleMethodologyPrompt(options.methodology, preference))
    if (drafts === 1) {
      for (const item of [...sections, 'added_context', 'behavior_change', 'ta 表示会公开私聊。']) expect(input.prompt).toContain(item)
    } else {
      expect(input.prompt).toContain(sections[0])
      const earlier = await io.read({ messageId: '1', before: 0, after: 0 }, 1000)
      expect(earlier.page).toMatchObject({ status: 'ok', transcript: expect.stringContaining(originals[0]) })
    }
    return reply(io, 'draft-' + drafts, draft(drafts === 2))
  } })
  expect(requests).toEqual([0, 1, 1, 2, 2])
  expect(drafts).toBe(2)
  expect(f.commits.map(c => [c.coverage, c.card.segmentIndex, c.receiptId])).toEqual([[2, 0, 'extract-1'], [4, 1, 'extract-3'], [6, 2, 'extract-5']])
  expect(f.events.mock.calls.filter(([stage]) => stage === 'segment')).toHaveLength(3)
  expect(f.db().listInsightEvidenceCards(f.taskId).map(c => c.data)).toEqual([0, 1, 2].map(evidence))
  expect(await f.db().completeAnalysis(f.taskId, report)).toMatchObject({ state: 'completed', analyzedMessages: 6,
    usage: { inputTokens: 420, outputTokens: 70 } })
  expect(await f.trace()).toMatchObject({ pipeline: 'segmented-insight-v1', totalMessages: 6,
    evidenceCards: [0, 1, 2].map(index => ({ segmentIndex: index, data: evidence(index) })),
    timeCoverage: { initial: { segmentCitationCounts: [0, 0, 1] }, correctionTriggered: true,
      final: { segmentCitationCounts: [1, 0, 1] } } })
})

test('第一段提交后重开资料库并更换模型，后两段复用已存证据', async () => {
  const f = await setup()
  const controller = new AbortController()
  const first = f.options()
  await expect(generateSegmentedInsight({ ...first, signal: controller.signal,
    save: async (state, receipt, card) => {
      await first.save(state, receipt, card)
      if (card) controller.abort()
    },
    run: async (input, io) => {
      expect(input.prompt).toContain('segmentIndex: 0\n')
      return reply(io, 'first-request', evidence(0))
    },
  })).rejects.toHaveProperty('name', 'AbortError')
  expect(await f.trace()).toMatchObject({ evidenceCards: [{ segmentIndex: 0 }] })
  await f.db().saveAnalysis(f.taskId, { state: 'stopped' })
  f.reopen()
  await f.db().resumeAnalysis(f.taskId, { modelId: 'replacement', version: 1 })
  const resumed = f.options()
  expect(resumed.checkpoint).toMatchObject({ version: 'segmented-insight-v1', requests: 1, coverage: { coveredMessageIds: ['1', '2'] } })
  const seen: number[] = []
  const report = await generateSegmentedInsight({ ...resumed, run: async (input, io) => {
    expect(input.model.id).toBe('replacement')
    if (input.insightSession?.mode !== 'segment') return reply(io, 'resumed-report', draft(true))
    const index = Number(input.prompt.match(/segmentIndex: (\d+)/)![1])
    seen.push(index)
    expect(input.prompt).toContain(sections[0])
    return reply(io, 'resumed-' + index, evidence(index))
  } })
  expect(seen).toEqual([1, 2])
  expect(await f.db().completeAnalysis(f.taskId, report)).toMatchObject({ usage: { inputTokens: 240, outputTokens: 40 } })
  expect(f.store().reader.prepare('SELECT model_id,count(*) AS n FROM ai_request_usage GROUP BY model_id ORDER BY model_id').all())
    .toEqual([{ model_id: 'first', n: 1n }, { model_id: 'replacement', n: 3n }])
})

test('重复虚构编号只纠正一次，失败回执落盘且没有任何已覆盖原文', async () => {
  const f = await setup()
  let calls = 0
  const options = f.options()
  await expect(generateSegmentedInsight({ ...options, run: async (input, io) => {
    calls++
    if (calls === 2) expect(input.prompt).toContain('请修正')
    const card = evidence(0)
    card.events[0].messageIds = ['9999']
    return reply(io, 'invalid-' + calls, card)
  } })).rejects.toHaveProperty('code', 'INVALID_EVIDENCE')
  expect(calls).toBe(2)
  expect(await options.listCards()).toEqual([])
  expect(f.db().getAnalysis(f.taskId)).toMatchObject({ analyzedMessages: 0, usage: { inputTokens: 120, outputTokens: 20 } })
  const checkpoint: SegmentedInsightCheckpoint = JSON.parse(f.db().analysisContext(f.taskId).checkpoint!)
  expect(checkpoint.coverage.coveredMessageIds).toEqual([])
})

test('新模型放不下原计划时只拆后续时段，保留早期证据编号与完整原话', async () => {
  const texts = originals.map(line => line + 'x'.repeat(6000))
  const f = await setup(texts, 8000)
  const first = f.options()
  const controller = new AbortController()
  await expect(generateSegmentedInsight({ ...first, signal: controller.signal, run: async (_, io) => reply(io, 'first', evidence(0)),
    save: async (state, receipt, card) => {
      await first.save(state, receipt, card)
      if (card) controller.abort()
    },
  })).rejects.toHaveProperty('name', 'AbortError')
  await f.db().saveAnalysis(f.taskId, { state: 'stopped' })
  await f.db().resumeAnalysis(f.taskId, { modelId: 'replacement', version: 1 })
  const seen: string[] = []
  const report = await generateSegmentedInsight({ ...f.options(), run: async (input, io) => {
    if (input.insightSession?.mode !== 'segment') return reply(io, 'final', draft(true))
    const transcript = input.prompt.split('transcript:\n')[1]
    const id = transcript.match(/^([0-9]+) /m)![1]
    expect(transcript).toContain(texts[Number(id) - 1])
    const index = seen.push(id)
    return reply(io, 'small-' + index, { period: '第' + id + '天', events: [{ summary: originals[Number(id) - 1],
      options: '', selfChoice: '', counterpartResponse: '', messageIds: [id] }], selfSignals: [], openThreads: [], riskSignals: [],
      revisions: [{ targetSegment: 0, kind: 'added_context', priorClaim: sections[0], revisedObservation: originals[Number(id) - 1], messageIds: ['1', id] }] })
  } })
  expect(seen).toEqual(['3', '4', '5', '6'])
  expect(f.db().listInsightEvidenceCards(f.taskId).map(card => [card.segmentIndex, card.startMessageId, card.endMessageId]))
    .toEqual([[0, '1', '2'], [1, '3', '3'], [2, '4', '4'], [3, '5', '5'], [4, '6', '6']])
  expect(await f.db().completeAnalysis(f.taskId, report)).toMatchObject({ analyzedMessages: 6 })
})

test('首段过载按退避重新请求，已存费用与进度分别保留', async () => {
  const f = await setup()
  const options = f.options()
  const controller = new AbortController()
  let calls = 0
  await expect(generateSegmentedInsight({ ...options, signal: controller.signal, run: async (input, io) => {
    expect(input.checkpoint).toBeNull()
    if (++calls === 1) {
      await io.record({ type: 'requestStart', kind: 'inference', requestId: 'overloaded' })
      await io.record({ type: 'request', kind: 'inference', requestId: 'overloaded', success: false,
        failureCode: 'INSIGHT_PROVIDER_OVERLOADED', spans: [], usage: { inputTokens: 4, outputTokens: 0 }, checkpoint: null })
      throw Object.assign(new Error('服务过载'), { code: 'INSIGHT_PROVIDER_OVERLOADED' })
    }
    return reply(io, 'retried', evidence(0))
  }, save: async (state, receipt, card) => {
    await options.save(state, receipt, card)
    if (card) controller.abort()
  } })).rejects.toHaveProperty('name', 'AbortError')
  expect(calls).toBe(2)
  expect(f.db().getAnalysis(f.taskId)).toMatchObject({ analyzedMessages: 2, usage: { inputTokens: 64, outputTokens: 10 } })
  expect(f.events.mock.calls).toContainEqual(['retry', expect.objectContaining({ attempt: 1, code: 'INSIGHT_PROVIDER_OVERLOADED' }), { retry: true }])
})

test('达到请求、输入或输出保护上限时均阻止发出下一次分段请求', async () => {
  const f = await setup()
  const options = f.options()
  for (const field of ['requests', 'input', 'output'] as const) {
    const workload = await insightWorkload(options.model, options.snapshot, false)
    const checkpoint: SegmentedInsightCheckpoint = { version: 'segmented-insight-v1', taskId: f.taskId, requests: 0, input: 0, output: 0,
      stalled: 0, checkpoint: null, coverage: { coveredMessageIds: [], partial: {} }, processing: options.processing,
      segments: options.segments, workload, [field]: workload.protection[field] }
    await expect(generateSegmentedInsight({ ...options, checkpoint, run: async (_, io) => {
      await io.record({ type: 'requestStart', kind: 'inference', requestId: field })
      throw Error('请求超出上限')
    } })).rejects.toHaveProperty('code', 'INSIGHT_BUDGET_EXHAUSTED')
  }
  expect(f.store().reader.prepare('SELECT count(*) AS n FROM ai_request_usage').get()).toEqual({ n: 0n })
  expect(f.db().getAnalysis(f.taskId).analyzedMessages).toBe(0)
})

test.each([true, false])('成稿历史超出容量时仅重建一次全部证据卡与待办时段纠正，重建后可成稿=%s', async fits => {
  const f = await setup()
  const leaves: (string | null | undefined)[] = []
  const run = generateSegmentedInsight({ ...f.options(), run: async (input, io) => {
    if (input.insightSession?.mode === 'segment') {
      const index = Number(input.prompt.match(/segmentIndex: (\d+)/)![1])
      return reply(io, 'extract-' + index, evidence(index))
    }
    leaves.push(input.checkpoint)
    if (leaves.length === 1) return reply(io, 'late-only', draft(false))
    if (leaves.length === 2) throw new BoundaryError('MODEL_CONTEXT_LIMIT', '成稿会话超出容量。')
    expect(leaves).toHaveLength(3)
    expect(input.checkpoint).toBeNull()
    for (const period of sections) expect(input.prompt).toContain(period)
    expect(input.prompt).toContain('尚无引用的早期时段')
    if (!fits) throw new BoundaryError('MODEL_CONTEXT_LIMIT', '证据卡超出容量。')
    return reply(io, 'complete', draft(true))
  } })
  if (fits) await expect(run).resolves.toMatchObject({ citations: [{ id: 'c1' }, { id: 'c5' }] })
  else await expect(run).rejects.toHaveProperty('code', 'MODEL_CONTEXT_LIMIT')
  expect(leaves).toEqual([null, 'late-only', null])
  expect(f.db().getAnalysis(f.taskId).analyzedMessages).toBe(6)
  expect(f.commits).toHaveLength(3)
})
