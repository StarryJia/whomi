import { expect, test } from 'vitest'
import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import type { InsightCheckpoint } from '../../electron/main/insight-checkpoint'
import { generateInsight, type InsightGenerationDeps } from '../../electron/main/insight-generation'

const model: AiModel = {
  id: 'fixture', label: 'Fixture', model: 'fixture', baseUrl: 'http://localhost',
  contextWindow: 12000, maxInputTokens: 3200, maxTokens: 600, enabled: true, version: 1, hasCredential: false,
}
const source = (id: string, isSelf: boolean, text: string, replyToMessageId: string | null = null): InsightSourceMessage => ({
  id, revision: 'rev-' + id, sentAtMs: Date.UTC(2026, 9, 1) + Number(id) * 60000,
  senderName: isSelf ? '本人' : '对方', isSelf, text, replyToMessageId,
})

const noObservations = { observations: [], openThreads: [], candidates: [] }
const noConclusion = { aboutYou: [], relationship: [], citations: [], limitations: ['材料有限。'], judgments: [] }
const result = (payload: unknown, usage: { inputTokens?: number; outputTokens?: number } = { inputTokens: 18, outputTokens: 10 }) => ({
  text: JSON.stringify(payload), usage, checkpoint: '',
})
const limits = { maxChecks: 2, maxRoundsPerCheck: 2, maxCalls: 8, maxInputTokens: 50000, maxOutputTokens: 8000, maxElapsedMs: 60000 }

function setup(messages: InsightSourceMessage[], run: InsightGenerationDeps['run']) {
  const snapshot: InsightSnapshot = {
    taskId: '7', scope: { kind: 'all' }, timezone: 'Asia/Shanghai', createdAtMs: 1000,
    sourceStartTimeMs: messages[0].sentAtMs, sourceEndTimeMs: messages.at(-1)!.sentAtMs,
    sources: messages.map(message => ({ messageId: message.id, revision: message.revision })),
  }
  const input = { snapshot, conversationId: '8', model, prompts: defaultInsightPrompts, limits, checkpoint: null }
  const state: { checkpoint: InsightCheckpoint | null; reads: string[][]; writes: InsightCheckpoint[] } = {
    checkpoint: null, reads: [], writes: [],
  }
  const deps: InsightGenerationDeps = {
    run,
    async read(ids) {
      state.reads.push([...ids])
      return messages.filter(message => ids.includes(message.id))
    },
    async saveCheckpoint(value) {
      state.checkpoint = structuredClone(value)
      state.writes.push(state.checkpoint)
    },
    signal: new AbortController().signal,
    onText: () => {},
    async countInput(request) {
      return { method: 'tokenizer', tokens: Math.ceil(Buffer.byteLength(request.systemPrompt) / 4) + Buffer.byteLength(request.prompt) }
    },
  }
  return { input, deps, state }
}

test('later evidence revises a first impression through a bounded reread without increasing coverage', async () => {
  const messages = [
    source('1', true, '先给你三个办法。' + 'a'.repeat(1300)),
    source('2', false, '我想先说完。' + 'b'.repeat(1300)),
    source('3', false, '这次我确实需要你给个主意。' + 'c'.repeat(1300), '1'),
  ]
  const requests: { stage: string }[] = []
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    requests.push(payload)
    expect((await deps.countInput!(request, request.model)).tokens).toBeLessThanOrEqual(3200)
    if (payload.stage === 'reading') {
      const first = payload.messages.find((item: InsightSourceMessage) => item.id === '1')
      return result(first ? {
        observations: [{ text: '你直接给了三个办法。', sourceIds: ['1'] }],
        openThreads: [{ text: '何时需要建议？', sourceIds: ['1'] }],
        candidates: [{ observation: '直接给建议可能让 ta 无法讲完。', supportingIds: ['1'] }],
      } : payload.messages.some((item: InsightSourceMessage) => item.id === '3') ? {
        ...noObservations,
        observations: [{ text: 'ta 在稍后的对话主动征求建议。', sourceIds: ['3'] }],
      } : noObservations)
    }
    if (payload.stage === 'checking') {
      if (payload.check.round === 1) return result({
        action: 'read', checkId: payload.check.id, messageIds: ['3'], purpose: '检查 ta 有没有主动求助',
        evidenceNotes: [{ sourceId: '1', quote: '先给你三个办法。', text: '你先给了建议。' }],
      })
      expect(payload.evidence.map((item: InsightSourceMessage) => item.id)).toContain('3')
      return result({
        action: 'finish', checkId: payload.check.id, revisedObservation: '是否合适取决于 ta 当时想要倾听还是建议。',
        supportingIds: ['1'], counterexampleIds: ['3'], alternativeExplanations: ['两个时刻的需求不同。'], limitations: ['仅限这次互动。'],
      })
    }
    expect(payload.checks[0].finding.revisedObservation).toContain('当时')
    return result({
      aboutYou: [{ content: [{ text: '你提出了三个办法', citationId: 'first' }] }],
      relationship: [{ content: [{ text: 'ta 后来主动征求建议', citationId: 'later' }] }],
      citations: [{ id: 'first', fragments: [{ messageIds: ['1'] }] }, { id: 'later', fragments: [{ messageIds: ['3'] }] }],
      limitations: ['这段材料只显示两次互动。'], judgments: [{
        dimension: 'TF', direction: null, text: '你提出解决办法，ta 主动求助的时机也不同。',
        supportingIds: ['1'], counterexampleIds: ['3'], alternativeExplanations: ['当时需求不同。'], limitations: ['适用范围有限。'],
      }],
    })
  })
  const report = await generateInsight(input, deps)
  expect(requests.filter(request => request.stage === 'reading').length).toBeGreaterThan(1)
  expect(requests.filter(request => request.stage === 'checking')).toHaveLength(2)
  expect(state.writes.filter(checkpoint => checkpoint.stage === 'checking').map(checkpoint => checkpoint.coveredMessageIds))
    .toEqual(state.writes.filter(checkpoint => checkpoint.stage === 'checking').map(() => ['1', '2', '3']))
  expect(state.reads).toContainEqual(['3'])
  expect(report.format).toBe('conversation-insights-v1')
  expect(report.citations[1].fragments[0].sources).toEqual([{ messageId: '3', revision: 'rev-3' }])
  expect(report.judgments?.[0]).toMatchObject({
    direction: null,
    supportingSources: [{ messageId: '1', revision: 'rev-1' }],
    counterexampleSources: [{ messageId: '3', revision: 'rev-3' }],
  })
})

test('an explicit reply and an unfinished item carry earlier sources into the next batch within its independent budget', async () => {
  const messages = [
    source('1', true, '周五原约定'),
    source('2', false, '这件事稍后聊。'),
    source('3', true, 'x'.repeat(2800)),
    source('4', false, '改到周一', '1'),
  ]
  const { input, deps } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage !== 'reading') return result(noConclusion)
    if (payload.messages.some((item: InsightSourceMessage) => item.id === '4')) {
      expect(payload.relatedMessages.map((item: InsightSourceMessage) => item.id)).toEqual(['1', '2'])
    }
    return result(payload.messages.some((item: InsightSourceMessage) => item.id === '2') ? {
      ...noObservations, openThreads: [{ text: '回复找时间', sourceIds: ['2'] }],
    } : noObservations)
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
})

test('selecting a visible leaf note rereads its original sources and supports revising the initial observation', async () => {
  const messages = [
    source('2', true, '每次都等着我来安排，想到这些就有点累。'),
    source('3', false, '这次几件事情碰在一起，是挺费精力的。', '2'),
    source('4', true, '我现在只想先歇一会，聚会还是照常。', '3'),
    source('19', false, '上个月是我订场地，本月说好轮到你。', '2'),
    source('20', true, '上个月确实是你张罗，说每次不准确。', '19'),
  ]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({
      ...noObservations,
      observations: [
        { text: '本人陈述反复承担。', sourceIds: ['2'] },
        { text: '对方回应本次疲惫。', sourceIds: ['3'] },
        { text: '本人暂时休息。', sourceIds: ['4'] },
        { text: '当次聚会照常。', sourceIds: ['4'] },
        { text: '陈述与回应的时间范围不同。', sourceIds: ['2', '3'] },
        { text: '后文明确轮流分工，本人撤回每次的概括。', sourceIds: ['2', '19', '20'] },
      ], candidates: [{ observation: '是否长期由本人承担安排，需要核实其他场次。', supportingIds: ['2', '3', '4'] }],
    })
    if (payload.stage === 'checking' && payload.check.round === 1) return result({
      action: 'navigate', checkId: payload.check.id, navigationId: 5, offset: 0,
      evidenceNotes: [{ sourceId: '2', quote: '每次都等着我来安排，想到这些就有点累。', text: '不能据此确认长期分工。' }],
    })
    if (payload.stage === 'checking') {
      expect(payload.evidence.map((message: InsightSourceMessage) => message.id)).toEqual(['19', '20'])
      expect(payload.evidenceNotes[0].quote).toBe('每次都等着我来安排，想到这些就有点累。')
      return result({ action: 'finish', checkId: payload.check.id, revisedObservation: '撤回长期单方承担的概括，已有轮流分工；当次疲惫仍有依据。',
        supportingIds: ['2'], counterexampleIds: ['19', '20'], alternativeExplanations: ['当次事情集中。'], limitations: ['仅限已见场次。'] })
    }
    return result(noConclusion)
  })
  await generateInsight(input, deps)
  expect(state.reads).toContainEqual(['19', '20'])
  expect(state.checkpoint?.checks[0].finding).toMatchObject({
    revisedObservation: '撤回长期单方承担的概括，已有轮流分工；当次疲惫仍有依据。', counterexampleIds: ['19', '20'],
  })
  expect(state.checkpoint?.coveredMessageIds).toEqual(['2', '3', '4', '19', '20'])
  expect(state.checkpoint?.attempts.filter(attempt => attempt.stage === 'checking')).toHaveLength(2)
})

test.each([{ navigationId: 99, offset: 0 }, { navigationId: 0, offset: 1 }])('navigation rejects an unavailable node or invalid leaf offset: %j', async navigation => {
  const { input, deps, state } = setup([source('1', true, '有待核实的安排。')], async request => {
    if (JSON.parse(request.prompt).stage === 'reading') return result({ ...noObservations,
      observations: [{ text: '安排尚未确认。', sourceIds: ['1'] }], candidates: [{ observation: '需要核对安排。', supportingIds: ['1'] }] })
    return result({ action: 'navigate', checkId: '1', ...navigation, evidenceNotes: [] })
  })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.reads).toEqual([['1'], ['1']])
})

test('a fabricated check read outside frozen sources reaches neither the source reader nor the manuscript', async () => {
  const { input, deps, state } = setup([source('1', true, '原文', '99')], async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') {
      expect(payload.messages[0].replyToMessageId).toBeNull()
      return result({ ...noObservations, candidates: [{ observation: '待核实', supportingIds: ['1'] }] })
    }
    if (payload.stage === 'checking') return result({
      action: 'read', checkId: payload.check.id, messageIds: ['99'], purpose: '试图展开任务范围',
    })
    throw new Error('manuscript ran after a range violation')
  })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.reads.flat()).not.toContain('99')
})

test.each(['read', 'navigate'])('a repeated %s ends with an explicit uncertainty and neither invents a judgment nor loops', async action => {
  const { input, deps, state } = setup([source('1', true, '首句'), source('2', false, '后句')], async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({
      ...noObservations, observations: [{ text: '后续回应。', sourceIds: ['2'] }],
      candidates: [{ observation: '需要确认', supportingIds: ['1'] }],
    })
    if (payload.stage === 'checking') {
      if (payload.check.round === 2) expect(payload.earlierEvidence.map((message: InsightSourceMessage) => message.text)).toEqual(['首句'])
      return result(action === 'read'
        ? { action, checkId: payload.check.id, messageIds: ['2'], purpose: '需要再看' }
        : { action, checkId: payload.check.id, navigationId: 0, offset: 0 })
    }
    expect(payload.checks[0]).toMatchObject({ state: 'inconclusive', finding: null })
    return result(noConclusion)
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ judgments: [] })
  expect(state.reads.filter(ids => ids.length === 1 && ids[0] === '2')).toHaveLength(1)
})

test('a crash after the provider response keeps the reserved call and does not let recovery reset its allowance', async () => {
  let dispatched = 0
  const { input, deps, state } = setup([source('1', true, '正文')], async () => {
    dispatched++
    return result(noObservations, {})
  })
  const save = deps.saveCheckpoint
  deps.saveCheckpoint = async checkpoint => {
    if (dispatched) throw new Error('fixture crash before checkpoint save')
    await save(checkpoint)
  }
  await expect(generateInsight({ ...input, limits: { ...limits, maxCalls: 2 } }, deps)).rejects.toThrow('fixture crash')
  expect(state.checkpoint).toMatchObject({ callsReserved: 1, coveredMessageIds: [] })
  expect(state.checkpoint?.attempts[0]).toMatchObject({ status: 'pending' })
  deps.saveCheckpoint = save
  await expect(generateInsight({ ...input, checkpoint: state.checkpoint }, deps)).rejects.toMatchObject({ code: 'INSIGHT_BUDGET_EXHAUSTED' })
  expect(dispatched).toBe(1)
  expect(state.checkpoint?.attempts[0]).toMatchObject({ status: 'unknown' })
  expect(state.checkpoint?.attempts[0].usage?.inputTokens).toBeUndefined()
  expect(state.checkpoint?.callsReserved).toBe(1)
})

test('capacity failures halve the saved fragment within eight retries without counting the incomplete source', async () => {
  let dispatched = 0
  const { input, deps, state } = setup([source('1', true, '字'.repeat(4000))], async () => {
    dispatched++
    throw Object.assign(new Error('fixture upstream rejected size'), { code: 'MODEL_CONTEXT_LIMIT' })
  })
  await expect(generateInsight({ ...input, limits: { ...limits, maxCalls: 15 } }, deps))
    .rejects.toMatchObject({ code: 'MODEL_CONTEXT_LIMIT' })
  expect(dispatched).toBeGreaterThan(1)
  expect(dispatched).toBeLessThanOrEqual(9)
  expect(state.checkpoint?.callsReserved).toBe(dispatched)
  expect(state.checkpoint?.coveredMessageIds).toEqual([])
  expect(state.checkpoint?.pendingRead?.depth).toBe(dispatched - 1)
})

test('truncated manuscripts spend the shared allowance and cannot become successful reports', async () => {
  const { input, deps, state } = setup([source('1', true, '正文')], async request => {
    if (JSON.parse(request.prompt).stage === 'reading') return result(noObservations)
    return { ...result(noConclusion, { outputTokens: 500 }), stopReason: 'length' }
  })
  await expect(generateInsight({ ...input, limits: { ...limits, maxCalls: 2 } }, deps))
    .rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' })
  expect(state.checkpoint?.callsReserved).toBe(2)
  expect(state.checkpoint?.attempts.at(-1)?.usage).toEqual({ outputTokens: 500 })
  expect(state.checkpoint?.coveredMessageIds).toEqual(['1'])
})

test('the writing request limits visible caveats to the conversation and keeps internal analysis fields out of the report text', async () => {
  const { input, deps } = setup([source('1', true, '正文')], async request => {
    if (JSON.parse(request.prompt).stage === 'reading') return result(noObservations)
    expect(request.systemPrompt).toMatch(/报告正文和限制[^。]*原文[^。]*不确定[^。]*可尝试/)
    expect(request.systemPrompt).toMatch(/不要在报告文字中[^。]*程序字段[^。]*摘要[^。]*核查阶段/)
    return result(noConclusion)
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
})

test('read-backed facts can receive a cited neutral report without a checked interpretation', async () => {
  let writingCalls = 0
  const { input, deps } = setup([source('1', true, '我只能周五陪你。')], async request => {
    if (JSON.parse(request.prompt).stage === 'reading') return result({
      ...noObservations, observations: [{ text: '本人只能周五陪同。', sourceIds: ['1'] }],
    })
    writingCalls++
    const canCiteObservedFacts = /observations[^。]*逐批阅读原文[^。]*有来源的事实/.test(request.systemPrompt)
      && /checks 为空[^。]*中性正文/.test(request.systemPrompt)
    if (!canCiteObservedFacts) {
      // 实测压缩修复后一度返回的空文稿。
      return result({ ...noConclusion, limitations: ['目前没有你和 ta 对话的逐字原文，无法确认具体措辞。'] })
    }
    return result({
      ...noConclusion, aboutYou: [{ content: [{ text: '你明确了自己能陪同的日期', citationId: 'day' }] }],
      citations: [{ id: 'day', fragments: [{ messageIds: ['1'] }] }],
    })
  })
  const report = await generateInsight(input, deps)
  expect(report.aboutYou).toEqual([{ content: [{ text: '你明确了自己能陪同的日期', citationId: 'day' }] }])
  expect(report.judgments).toEqual([])
  expect(writingCalls).toBe(1)
})

test.each([true, false])('a frozen source is citable from an open thread only when the writer receives that note (%s)', async includeThread => {
  const messages = [source('1', true, '我只能周五陪你。'), source('2', true, '包裹不急，可以顺手带上。')]
  const { input, deps } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({
      ...noObservations,
      observations: [{ text: '本人只能周五陪同。', sourceIds: ['1'] }],
      openThreads: includeThread ? [{ text: '包裹可顺路取走，未见取回确认。', sourceIds: ['2'] }] : [],
    })
    expect(payload.openThreads.length).toBe(includeThread ? 1 : 0)
    return result({
      ...noConclusion, aboutYou: [{ content: [{ text: '你提到包裹不急', citationId: 'parcel' }] }],
      citations: [{ id: 'parcel', fragments: [{ messageIds: ['2'] }] }],
    })
  })
  if (includeThread) {
    await expect(generateInsight(input, deps)).resolves.toMatchObject({
      citations: [{ id: 'parcel', fragments: [{ sources: [{ messageId: '2', revision: 'rev-2' }] }] }],
    })
  } else {
    await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  }
})

test('a reread uses the same bounded shrinking and resumes the remainder of a rejected source', async () => {
  let rejected = false
  const readText: string[] = []
  const message = source('1', true, 'word '.repeat(270))
  const { input, deps, state } = setup([message], async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({
      ...noObservations, candidates: [{ observation: '先核实', supportingIds: ['1'] }],
    })
    if (payload.stage === 'checking') {
      if (!rejected) {
        rejected = true
        throw Object.assign(new Error('fixture rejected reread capacity'), { code: 'MODEL_CONTEXT_LIMIT' })
      }
      readText.push(...payload.evidence.map((item: InsightSourceMessage) => item.text))
      if (!payload.hasMoreEvidence) expect(payload.evidenceNotes[0].quote).toBe('word word')
      return result(payload.hasMoreEvidence ? {
        action: 'read', checkId: payload.check.id, messageIds: ['1'], purpose: '继续读取同一消息的下一片',
        evidenceNotes: [{ sourceId: '1', quote: 'word word', text: '记录第一片。' }],
      } : {
        action: 'finish', checkId: payload.check.id, revisedObservation: '阅读结束。',
        supportingIds: ['1'], counterexampleIds: [], alternativeExplanations: [], limitations: [],
      })
    }
    return result(noConclusion)
  })
  await generateInsight({ ...input, limits: { ...limits, maxRoundsPerCheck: 3 } }, deps)
  expect(readText.length).toBe(2)
  expect(readText.join('')).toBe(message.text)
  expect(state.checkpoint?.attempts.filter(attempt => attempt.stage === 'checking')).toHaveLength(3)
  expect(state.checkpoint?.coveredMessageIds).toEqual(['1'])
})

test('a rejected navigation wrapper gets a repair request with only the compression output contract', async () => {
  const messages = Array.from({ length: 4 }, (_, index) => source(String(index + 1), true, 'x'.repeat(2100)))
  let compressionCalls = 0
  const readingPrompts: string[] = []
  const { input, deps } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      // 首次真实试验响应的外层形状及第一项。
      if (++compressionCalls === 1) return result({
        nodes: [{ text: '10月5日眼科复查：本人只能周五陪同，拟问周五号；对方回复1要求保留周一号，尚未改约，周一下午另有修车安排。', sourceIds: ['1', '2'] }],
      })
      if (compressionCalls === 2) expect(payload.repair).toBe(true)
      expect(request.systemPrompt).toMatch(/顶层[^。]*\{text,sourceIds:\[\]\}/)
      expect(request.systemPrompt).not.toContain('observations:[')
      expect(request.systemPrompt).not.toContain('openThreads:[')
      expect(request.systemPrompt).not.toContain('candidates:[')
      return result({ text: '本段合成观察。', sourceIds: payload.nodes[0].sourceIds })
    }
    if (payload.stage === 'reading') {
      readingPrompts.push(request.systemPrompt)
      return result({
        ...noObservations,
        observations: [{ text: '本批观察 ' + 'n'.repeat(1080), sourceIds: [payload.messages[0].id] }],
      })
    }
    expect(payload.observations.length).toBeGreaterThan(0)
    expect(payload.observations.length).toBeLessThan(4)
    return result(noConclusion)
  })
  await expect(generateInsight({ ...input, limits: { ...limits, maxCalls: 10 } }, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
  expect(compressionCalls).toBeGreaterThan(1)
  expect(readingPrompts.every(prompt => !prompt.includes('compress-navigation'))).toBe(true)
})

test('checking a later counterexample retains the frozen date, author and reply metadata of earlier quotes', async () => {
  const messages = [source('1', true, '我只能周五去周一的医院预约。'), source('3', false, '周一的医院预约取消了。', '1')]
  messages[1].sentAtMs = Date.UTC(2026, 10, 1)
  const { input, deps } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({
      ...noObservations, candidates: [{ observation: '核查后来发生什么', supportingIds: ['1'] }],
    })
    if (payload.stage === 'checking') {
      if (payload.check.round === 1) return result({
        action: 'read', checkId: payload.check.id, messageIds: ['3'], purpose: '核查旧安排是否改变',
        evidenceNotes: [{ sourceId: '1', quote: '我只能周五去周一的医院预约。', text: '你提到周一的预约，想改为周五。', sentAtMs: 0, isSelf: false, senderName: '错误作者', replyToMessageId: '3' }],
      })
      expect(payload.evidence.map((message: InsightSourceMessage) => message.text)).toEqual(['周一的医院预约取消了。'])
      expect(payload.evidenceNotes).toEqual([{
        sourceId: '1', quote: '我只能周五去周一的医院预约。', text: '你提到周一的预约，想改为周五。',
        sentAtMs: messages[0].sentAtMs, senderName: '本人', isSelf: true, replyToMessageId: null,
      }])
      expect(payload.evidence[0]).toMatchObject({ sentAtMs: Date.UTC(2026, 10, 1), isSelf: false, replyToMessageId: '1' })
      return result({
        action: 'finish', checkId: payload.check.id, revisedObservation: '后来是取消，不是改到周五。',
        supportingIds: ['1'], counterexampleIds: ['3'], alternativeExplanations: [], limitations: [],
      })
    }
    return result(noConclusion)
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
})

test('hierarchical navigation preserves the middle evidence and makes it available for a counterexample reread', async () => {
  const marker = '医院预约中段'
  const messages = Array.from({ length: 60 }, (_, index) => source(String(index + 1), index !== 5,
    (index === 5 ? '医院预约取消。' : '某间合成记录。') + 'x'.repeat(140)))
  const condensedLeafIds = new Set<string>()
  const compactionInputs: string[] = []
  let foundMiddle = false
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      compactionInputs.push(payload.nodes.map((node: { navigationId: number }) => node.navigationId).join(','))
      if (compactionInputs.length === 2) throw new Error('fixture interruption during navigation')
      for (const node of payload.nodes) if (!node.childCount) condensedLeafIds.add(node.sourceIds[0])
      const includesMiddle = payload.nodes.some((node: { text: string }) => node.text.includes(marker))
      return result({ text: includesMiddle ? marker : '本段合成记录。', sourceIds: payload.nodes[0].sourceIds })
    }
    if (payload.stage === 'reading') return result({
      ...noObservations,
      observations: payload.messages.map(({ id }: InsightSourceMessage) => ({ text: (id === '6' ? marker : '样本观察') + 'n'.repeat(150), sourceIds: [id] })),
      candidates: payload.messages.some(({ id }: InsightSourceMessage) => id === '1')
        ? [{ observation: '核查预约有没有照常进行', supportingIds: ['1'] }] : [],
    })
    if (payload.stage === 'checking') {
      const checkId = payload.check.id
      if (payload.evidence.some(({ id }: InsightSourceMessage) => id === '6')) {
        return result({
          action: 'finish', checkId, revisedObservation: '中段有一条取消通知。',
          supportingIds: ['1'], counterexampleIds: ['6'], alternativeExplanations: [], limitations: [],
        })
      }
      const navigator = payload.navigationPage ?? { nodes: payload.observations }
      const target = navigator.nodes.find((note: { text: string }) => note.text.includes(marker))
      if (!target) {
        expect(navigator.nextOffset).toBeDefined()
        return result({ action: 'navigate', checkId, navigationId: navigator.id, offset: navigator.nextOffset })
      }
      if (!target.childCount) {
        expect(target.sourceIds).toEqual(['6'])
        foundMiddle = true
        return result({ action: 'read', checkId, messageIds: ['6'], purpose: '回读中段取消通知' })
      }
      return result({ action: 'navigate', checkId, navigationId: target.navigationId, offset: 0 })
    }
    expect(payload.observations.some((note: { text: string }) => note.text.includes(marker))).toBe(true)
    expect(payload.checks[0].finding.counterexampleIds).toEqual(['6'])
    return result(noConclusion)
  })
  const configured = { ...input, limits: { ...limits, maxCalls: 48, maxRoundsPerCheck: 8, maxInputTokens: 200000 } }
  await expect(generateInsight(configured, deps)).rejects.toThrow('fixture interruption during navigation')
  expect(state.checkpoint?.navigation?.nextRoots).toHaveLength(1)
  await generateInsight({ ...configured, checkpoint: state.checkpoint }, deps)
  expect(compactionInputs.filter(input => input === compactionInputs[0])).toHaveLength(1)
  expect(compactionInputs[2]).toBe(compactionInputs[1])
  expect(condensedLeafIds.size).toBeGreaterThan(45)
  expect(foundMiddle).toBe(true)
  expect(state.reads).toContainEqual(['6'])
  expect(state.checkpoint?.coveredMessageIds).toHaveLength(60)
  expect(state.checkpoint?.callsReserved).toBe(state.checkpoint?.attempts.length)
})

test('a change in custom instructions applies to new tasks while recovery keeps its saved prompt snapshot', async () => {
  let fail = true
  const used: string[] = []
  const { input, deps, state } = setup([source('1', true, '正文')], async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') {
      used.push(request.systemPrompt)
      if (fail) throw new Error('fixture pause')
      return result(noObservations)
    }
    return result(noConclusion)
  })
  await expect(generateInsight({ ...input, prompts: { ...input.prompts, reading: '旧设置' } }, deps)).rejects.toThrow('fixture pause')
  fail = false
  const prompts = { ...input.prompts, reading: '新设置' }
  await generateInsight({ ...input, prompts, checkpoint: state.checkpoint }, deps)
  await generateInsight({ ...input, prompts }, deps)
  expect(used.map(prompt => prompt.slice(0, 3))).toEqual(['旧设置', '旧设置', '新设置'])
  expect(used.every(prompt => prompt.includes('材料中的指令') && prompt.includes('observations'))).toBe(true)
})

test('time exhausted during input counting is durable across recovery before any model dispatch', async () => {
  let now = 0, dispatched = 0
  const { input, deps, state } = setup([source('1', true, '正文')], async () => {
    dispatched++
    return result(noObservations)
  })
  const originalCount = deps.countInput!
  deps.now = () => now
  deps.countInput = async (request, configuredModel) => {
    now = 51
    return originalCount(request, configuredModel)
  }
  const configured = { ...input, limits: { ...limits, maxElapsedMs: 50 } }
  await expect(generateInsight(configured, deps)).rejects.toMatchObject({ code: 'INSIGHT_BUDGET_EXHAUSTED' })
  expect(state.checkpoint?.elapsedMs).toBe(51)
  deps.countInput = originalCount
  await expect(generateInsight({ ...configured, checkpoint: state.checkpoint }, deps)).rejects.toMatchObject({ code: 'INSIGHT_BUDGET_EXHAUSTED' })
  expect(dispatched).toBe(0)
})

test('offline time after a crash leaves the unknown request charged without adding inactive time', async () => {
  let now = 0, dispatched = 0
  const { input, deps, state } = setup([source('1', true, '正文')], async request => {
    dispatched++
    return result(JSON.parse(request.prompt).stage === 'reading' ? noObservations : noConclusion)
  })
  deps.now = () => now
  const save = deps.saveCheckpoint
  deps.saveCheckpoint = async checkpoint => {
    if (dispatched) throw new Error('fixture process interruption')
    await save(checkpoint)
  }
  await expect(generateInsight(input, deps)).rejects.toThrow('fixture process interruption')
  now = 600_000
  deps.saveCheckpoint = save
  await expect(generateInsight({ ...input, checkpoint: state.checkpoint }, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
  expect(state.checkpoint).toMatchObject({ elapsedMs: 0, callsReserved: 3 })
  expect(state.checkpoint?.attempts[0]).toMatchObject({ status: 'unknown' })
})
