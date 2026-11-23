import { expect, test } from 'vitest'
import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { createInsightCheckpoint, type InsightCheckpoint } from '../../electron/main/insight-checkpoint'
import { generateInsight, type InsightGenerationDeps } from '../../electron/main/insight-generation'
import { createMessageProcessor } from '../../electron/main/message-processing'
import { defaultProcessing } from '../../src/shared/settings-contract'
import compressionTargetFixture from './fixtures/insight-compression-target.json'
import compressionCoverageFixture from './fixtures/insight-compression-coverage.json'
import compressionNetProgressFixture from './fixtures/insight-compression-net-progress.json'
import compressionMixedKindsFixture from './fixtures/insight-compression-mixed-kinds.json'

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
const previousArrangement = '每次都是我来安排，想到这些就有点累。'
const lastMonthArrangement = '上个月是我订场地，本月轮到你。'
const acknowledgeArrangement = '上个月确实是你张罗，说每次不准确。'
const arrangementNote = { sourceId: '1', quote: previousArrangement, text: '本人说每次都是自己安排，提到疲惫。' }
const arrangementCandidate = {
  observation: '本人是否一直单独负责聚会？', supportingIds: ['1'], reason: '核对其他月份由谁订场地。', evidenceNotes: [arrangementNote],
}
const arrangementFinding = {
  revisedObservation: '撤回每次均由本人安排的概括。当次安排使本人感到疲惫。',
  supportingIds: ['1'], counterexampleIds: ['3', '4'], alternativeExplanations: ['轮流分工。'], limitations: ['仅限已见月份。'],
}
const paddedSource = (id: string, isSelf: boolean, text: string, replyToMessageId: string | null = null) =>
  source(id, isSelf, text + 'x'.repeat(1300), replyToMessageId)
const result = (payload: unknown, usage: { inputTokens?: number; outputTokens?: number } = { inputTokens: 18, outputTokens: 10 }) => ({
  text: JSON.stringify(payload), usage, checkpoint: '',
})
const retainEntries = (payload: { nodes: { entries: { entryId: string; kind: string; text: string }[] }[] }) => ({
  text: '合成事实和未决事项。', facts: payload.nodes.flatMap(node => node.entries)
    .map(entry => ({ kind: entry.kind, text: entry.text, entryIds: [entry.entryId] })),
})
const limits = { maxChecks: 2, maxRoundsPerCheck: 2, maxCalls: 8, maxInputTokens: 50000, maxOutputTokens: 8000, maxElapsedMs: 60000 }

const preservedMemory = {
  text: '筹备分工与退款条件。', sourceIds: ['1'],
  facts: [
    { kind: 'fact', text: '本次筹备使本人疲惫，后文撤回每次由自己安排的概括。', entryIds: ['0:0', '1:0'] },
    { kind: 'fact', text: '余额一年有效、无最低消费，对方已接受。', entryIds: ['2:0', '3:0'] },
  ],
}

function memoryFixture(compress: unknown = preservedMemory, onWriting?: (payload: Record<string, any>) => void) {
  const messages = [source('1', true, '每次都由我安排，这次很累。'), source('2', true, '上个月是你安排，每次不准确。'),
    source('3', false, '余额一年有效且无最低消费，我接受。'), source('4', true, '余额条件确认了吗？')]
  const fixture = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') return result(compress)
    expect(payload.stage).toBe('writing')
    onWriting?.(payload)
    return result(noConclusion)
  })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: 4, textOffset: 0 }
  checkpoint.coveredMessageIds = ['1', '2', '3', '4']
  checkpoint.observations = [
    { text: '本人觉得每次均由自己安排且疲惫。' + '事'.repeat(350), sourceIds: ['1'] },
    { text: '本人后来承认上次由对方安排，撤回每次的概括。' + '事'.repeat(350), sourceIds: ['2'] },
    { text: '对方明确接受一年有效且无最低消费的余额。' + '事'.repeat(350), sourceIds: ['3'] },
  ]
  checkpoint.openThreads = [{ text: '余额有效期和使用限制是否确认？', sourceIds: ['4'] }]
  fixture.deps.countInput = async request => ({ method: 'tokenizer', tokens:
    JSON.parse(request.prompt).operation === 'compress-navigation' ? 100 : 100 + Buffer.byteLength(request.prompt) })
  return { ...fixture, input: { ...fixture.input, checkpoint } }
}

test('compaction keeps separate facts and all inherited sources while retiring an answered unknown before writing', async () => {
  const { input, deps, state } = memoryFixture(preservedMemory, payload => {
    expect(payload.observations).toEqual([
      { text: preservedMemory.facts[0].text, sourceIds: ['1', '2'] },
      { text: preservedMemory.facts[1].text, sourceIds: ['3', '4'] },
    ])
    expect(payload.openThreads).toEqual([])
  })
  await generateInsight(input, deps)
  expect(state.checkpoint?.observations[1].sourceIds).toEqual(['2'])
  expect(state.checkpoint?.checks).toEqual([])
})

test('compaction can separate an unknown from a mixed fact while retaining its known part and source', async () => {
  const response = { ...preservedMemory, facts: [...preservedMemory.facts,
    { kind: 'unknown', text: '下次由谁安排尚未确认。', entryIds: ['0:0'] },
  ] }
  const { input, deps } = memoryFixture(response, payload => {
    expect(payload.observations).toContainEqual({ text: preservedMemory.facts[0].text, sourceIds: ['1', '2'] })
    expect(payload.openThreads).toEqual([{ text: '下次由谁安排尚未确认。', sourceIds: ['1'] }])
  })
  input.checkpoint.observations[0].text = '本人说安排让自己疲惫，但未明确下次由谁安排。' + '事'.repeat(350)
  await generateInsight(input, deps)
})

test('compaction can separate known context from an unknown note while preserving that note as unresolved', async () => {
  const response = { ...preservedMemory, facts: [
    preservedMemory.facts[0], { kind: 'fact', text: '余额条件已接受。', entryIds: ['2:0'] },
    { kind: 'fact', text: '投影线已经测试正常。', entryIds: ['3:0'] },
    { kind: 'unknown', text: '是否已将投影线带到现场尚未确认。', entryIds: ['3:0'] },
  ] }
  const { input, deps } = memoryFixture(response, payload => {
    expect(payload.observations).toContainEqual({ text: '投影线已经测试正常。', sourceIds: ['4'] })
    expect(payload.openThreads).toEqual([{ text: '是否已将投影线带到现场尚未确认。', sourceIds: ['4'] }])
  })
  input.checkpoint.openThreads = [{ text: '计划携带已测试正常的投影线，是否带到现场仍未知。', sourceIds: ['4'] }]
  await generateInsight(input, deps)
})

test('splitting known context from several unknown notes preserves every unresolved input', async () => {
  const response = { ...preservedMemory, facts: [
    preservedMemory.facts[0], { kind: 'fact', text: '余额条件已接受。', entryIds: ['2:0'] },
    { kind: 'fact', text: '投影线已测试，活动室已预订。', entryIds: ['3:0', '4:0'] },
    { kind: 'unknown', text: '投影线是否带到现场未知。', entryIds: ['3:0'] },
  ] }
  const { input, deps } = memoryFixture(response)
  input.checkpoint.openThreads.push({ text: '活动室已预订，但篇名未知。', sourceIds: ['3'] })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
})

test('compression sends only fact entry identities and text while inheriting sources locally for writing', async () => {
  const { input, deps } = memoryFixture(preservedMemory, payload => {
    expect(payload.observations[0].sourceIds).toEqual(['1', '2'])
    expect(payload.observations[1].sourceIds).toEqual(['3', '4'])
  })
  const priorRun = deps.run
  deps.run = async (request, context) => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      for (const entry of payload.nodes.flatMap((node: { entries: object[] }) => node.entries)) {
        expect(entry).not.toHaveProperty('sourceIds')
      }
      expect(payload.targetFactTextLength).toBeGreaterThanOrEqual(160)
      expect(payload.targetFactTextLength).toBeLessThan(1000)
      expect(payload.maxFactCount).toBe(8)
    }
    return priorRun(request, context)
  }
  await generateInsight(input, deps)
})

test('verbatim compression stops after one repair before replacing any original facts', async () => {
  const { input, deps, state } = memoryFixture()
  let attempts = 0
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.operation).toBe('compress-navigation')
    attempts++
    return result({ text: '导航缩短。', facts: payload.nodes.flatMap((node: { entries: { entryId: string; kind: string; text: string }[] }) => node.entries)
      .map((entry: { entryId: string; kind: string; text: string }) => ({ kind: entry.kind, text: entry.text, entryIds: [entry.entryId] })) })
  }
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(attempts).toBe(2)
  expect(state.checkpoint?.navigation?.cursor).toBe(0)
  expect(state.checkpoint?.navigation?.nextRoots).toEqual([])
  expect(state.checkpoint?.navigation?.nodes).toHaveLength(4)
})

test('a shorter navigation cannot count as progress when the complete writing facts still exceed capacity', async () => {
  const { input, deps, state } = memoryFixture()
  input.checkpoint.observations = [{ text: '已'.repeat(160), sourceIds: ['1'] }]
  input.checkpoint.openThreads = []
  deps.countInput = async request => ({ method: 'tokenizer', tokens: JSON.parse(request.prompt).stage === 'writing' ? 4000 : 100 })
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.operation).toBe('compress-navigation')
    return result(retainEntries(payload))
  }
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(state.checkpoint?.navigation?.nodes).toHaveLength(1)
  expect(state.checkpoint?.navigation?.nextRoots).toEqual([])
})

test('a real 546-character compression remains valid above its 522-character target when writing memory shrinks by a quarter', async () => {
  const entries = compressionTargetFixture.entries.map(entry => ({ ...entry, kind: entry.kind as 'fact' | 'unknown' }))
  const ids = [...new Set(entries.flatMap(entry => entry.sourceIds))].sort((a, b) => Number(a) - Number(b))
  const messages = ids.map(id => source(id, true, '合成试验来源 ' + id))
  const { input, deps } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      expect(payload.targetFactTextLength ?? payload.maxFactTextLength).toBe(522)
      const sentEntries = payload.nodes.flatMap((node: { entries: { entryId: string; text: string }[] }) => node.entries)
      const currentId = new Map(entries.map((entry, index) => [`${index}:0`,
        sentEntries.find((sent: { text: string }) => sent.text === entry.text)!.entryId]))
      return result({ ...compressionTargetFixture.response, facts: compressionTargetFixture.response.facts.map(fact => ({
        ...fact, entryIds: fact.entryIds.map(id => currentId.get(id)),
      })) })
    }
    expect(payload.observations).toContainEqual({ text: '对方已追问带孩子路线中的年龄。', sourceIds: ['106'] })
    expect(payload.openThreads).toContainEqual({ text: '年龄及路线适宜性未明。', sourceIds: ['106'] })
    expect(Buffer.byteLength(JSON.stringify({ observations: payload.observations, openThreads: payload.openThreads }))).toBe(2389)
    return result(noConclusion)
  })
  deps.countInput = async request => ({ method: 'tokenizer', tokens:
    JSON.parse(request.prompt).operation === 'compress-navigation' ? 100 : 100 + Buffer.byteLength(request.prompt) })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: messages.length, textOffset: 0 }
  checkpoint.coveredMessageIds = ids
  checkpoint.openThreads = entries.map(({ text, sourceIds }) => ({ text, sourceIds }))
  expect(compressionTargetFixture.response.facts.reduce((sum, fact) => sum + [...fact.text].length, 0)).toBe(546)
  await generateInsight({ ...input, checkpoint }, deps)
})

test.each([{ length: 199, passes: true }, { length: 200, passes: false }, { length: 201, passes: false }])('compression requires strict writing-memory reduction unless the complete writer fits ($length characters)', async ({ length, passes }) => {
  const { input, deps, state } = memoryFixture()
  input.checkpoint.observations = [{ text: 'x'.repeat(200), sourceIds: ['1'] }]
  input.checkpoint.openThreads = []
  let attempts = 0
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.stage === 'writing' && (payload.observations?.[0]?.text.length ?? 0) > 199 ? 3500 : 100 }
  }
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation !== 'compress-navigation') return result(noConclusion)
    attempts++
    return result({ text: '缩短导航。', facts: [{ kind: 'fact', text: 'x'.repeat(length), entryIds: [payload.nodes[0].entries[0].entryId] }] })
  }
  if (passes) {
    await generateInsight(input, deps)
    expect(attempts).toBe(1)
  } else {
    await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
    expect(attempts).toBe(2)
    expect(state.checkpoint?.navigation?.nodes).toHaveLength(1)
    expect(state.checkpoint?.navigation).toMatchObject({ cursor: 0, nextRoots: [], repairs: 1 })
  }
})

test('a real second-layer compression that saves 18.63 percent advances while other memory still exceeds writing capacity', async () => {
  const entries = compressionNetProgressFixture.entries.map(entry => ({ ...entry, kind: entry.kind as 'fact' | 'unknown' }))
  const ids = [...new Set(entries.flatMap(entry => entry.sourceIds))]
  const messages = ids.map(id => source(id, true, '合成试验来源 ' + id))
  const stop = new Error('fixture accepted net compression before processing remaining memory')
  const { input, deps, state } = setup(messages, async request => {
    expect(JSON.parse(request.prompt).operation).toBe('compress-navigation')
    return result(compressionNetProgressFixture.response)
  })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: messages.length, textOffset: 0 }
  checkpoint.coveredMessageIds = ids
  const remaining = { kind: 'fact' as const, text: '后续材料。' + '事'.repeat(1000), sourceIds: [ids[0]] }
  checkpoint.observations = [...entries, remaining].filter(entry => entry.kind === 'fact').map(({ text, sourceIds }) => ({ text, sourceIds }))
  checkpoint.openThreads = entries.filter(entry => entry.kind === 'unknown').map(({ text, sourceIds }) => ({ text, sourceIds }))
  checkpoint.navigation = { factsVersion: 2, reconciled: false, cursor: 0, nextRoots: [], repairs: 0, roots: [0, 1], nodes: [
    { text: '先前压缩的事实。', sourceIds: ids, children: [], facts: entries },
    { text: remaining.text, sourceIds: remaining.sourceIds, children: [], facts: [remaining] },
  ] }
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.operation === 'compress-navigation'
      ? payload.nodes.length <= 1 ? 100 : 3500 : 100 + Buffer.byteLength(request.prompt) }
  }
  const priorSave = deps.saveCheckpoint
  deps.saveCheckpoint = async value => {
    await priorSave(value)
    if (value.navigation?.cursor === 1) throw stop
  }
  await expect(generateInsight({ ...input, checkpoint }, deps)).rejects.toBe(stop)
  expect(state.checkpoint?.callsReserved).toBe(1)
  const retained = state.checkpoint!.navigation!.nodes[2].facts!
  const bytes = (facts: typeof retained) => Buffer.byteLength(JSON.stringify({
    observations: facts.filter(fact => fact.kind === 'fact').map(({ text, sourceIds }) => ({ text, sourceIds })),
    openThreads: facts.filter(fact => fact.kind === 'unknown').map(({ text, sourceIds }) => ({ text, sourceIds })),
  }))
  expect(bytes(entries)).toBe(2694)
  expect(bytes(retained)).toBe(2192)
  expect(new Set(retained.flatMap(fact => fact.sourceIds))).toEqual(new Set(ids))
  expect(state.checkpoint?.navigation?.nodes[0].facts).toEqual(entries)
})

test('repeated one-byte compression progress still stops at the shared call budget', async () => {
  const { input, deps, state } = memoryFixture()
  input.checkpoint.observations = [{ text: 'x'.repeat(1000), sourceIds: ['1'] }]
  input.checkpoint.openThreads = []
  input.checkpoint.limits = { ...input.checkpoint.limits, maxCalls: 4 }
  let calls = 0
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.stage === 'writing'
      ? 2500 + (payload.observations?.[0]?.text.length ?? 0) : 100 }
  }
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.operation).toBe('compress-navigation')
    calls++
    const entry = payload.nodes[0].entries[0]
    return result({ text: '逐字精简。', facts: [{ kind: 'fact', text: entry.text.slice(0, -1), entryIds: [entry.entryId] }] })
  }
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INSIGHT_BUDGET_EXHAUSTED' })
  expect(calls).toBe(3)
  expect(state.checkpoint?.callsReserved).toBe(3)
  expect(state.checkpoint?.observations).toEqual(input.checkpoint.observations)
})

test('a jointly reconciled short memory can retain its wording when the complete writer already fits', async () => {
  const { input, deps } = memoryFixture()
  input.checkpoint.observations = [{ text: 'x'.repeat(200), sourceIds: ['1'] }]
  input.checkpoint.openThreads = [{ text: '后续仍未确认。', sourceIds: ['2'] }]
  deps.countInput = async () => ({ method: 'tokenizer', tokens: 100 })
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
    expect(payload.observations[0]).toEqual(input.checkpoint.observations[0])
    expect(payload.openThreads[0]).toEqual(input.checkpoint.openThreads[0])
    return result(noConclusion)
  }
  await generateInsight(input, deps)
})

test('resuming a rejected compression retains its single repair allowance and spent calls', async () => {
  const { input, deps, state } = memoryFixture()
  deps.run = async request => result(retainEntries(JSON.parse(request.prompt)))
  const priorSave = deps.saveCheckpoint
  let paused = false
  deps.saveCheckpoint = async value => {
    await priorSave(value)
    if (!paused && value.navigation?.repairs === 1) {
      paused = true
      throw new Error('fixture paused after compression repair was reserved')
    }
  }
  await expect(generateInsight(input, deps)).rejects.toThrow('fixture paused after compression repair was reserved')
  expect(state.checkpoint?.callsReserved).toBe(1)
  await expect(generateInsight({ ...input, checkpoint: state.checkpoint }, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(state.checkpoint?.callsReserved).toBe(2)
  expect(state.checkpoint?.navigation).toMatchObject({ repairs: 1, cursor: 0, nextRoots: [] })
})

test.each([false, true])('writing recompresses facts after a larger checked finding without repeating checking (resume at writing: %s)', async resumeAtWriting => {
  const messages = [source('1', true, '本次活动我已经安排好了。')]
  const original = { text: '本人已经安排本次活动。' + '细'.repeat(400), sourceIds: ['1'] }
  const finding = { revisedObservation: '已核实本次安排，历史分工仍未知。' + '补'.repeat(500),
    supportingIds: ['1'], counterexampleIds: [], alternativeExplanations: [], limitations: [] }
  const stages: string[] = []
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    stages.push(payload.operation ?? payload.stage)
    if (payload.stage === 'checking') return result({ action: 'finish', checkId: '1', ...finding })
    if (payload.operation === 'compress-navigation') return result({ text: '本次安排。', facts: [
      { kind: 'fact', text: '本人已安排本次活动。', entryIds: ['0:0'] },
    ] })
    expect(payload.checks[0].finding).toEqual(finding)
    expect(payload.observations).toEqual([{ text: '本人已安排本次活动。', sourceIds: ['1'] }])
    return result({ ...noConclusion, aboutYou: [{ content: [{ text: '你已安排这次活动。', citationId: 'arrangement' }] }],
      citations: [{ id: 'arrangement', fragments: [{ messageIds: ['1'] }] }] })
  })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.stage = 'checking'
  checkpoint.cursor = { messageIndex: 1, textOffset: 0 }
  checkpoint.coveredMessageIds = ['1']
  checkpoint.observations = [original]
  checkpoint.navigation = { factsVersion: 2, reconciled: true, cursor: 0, nextRoots: [], repairs: 0, roots: [0],
    nodes: [{ text: '安排细节。', sourceIds: ['1'], children: [], facts: [{ kind: 'fact', ...original }] }] }
  checkpoint.checks = [{ id: '1', observation: '核实安排', supportingIds: ['1'], state: 'pending', rounds: 0,
    seenEvidenceIds: [], evidenceNotes: [], navigationRequests: [], pendingNavigation: null, pendingIds: ['1'],
    pendingCursor: { messageIndex: 0, textOffset: 0 }, pendingThrough: null, shrinkDepth: 0, repairs: 0,
    purpose: '核实安排', finding: null }]
  let paused = false
  const priorSave = deps.saveCheckpoint
  deps.saveCheckpoint = async value => {
    await priorSave(value)
    if (resumeAtWriting && !paused && value.stage === 'writing') {
      paused = true
      throw new Error('fixture paused before writing')
    }
  }
  if (resumeAtWriting) {
    await expect(generateInsight({ ...input, checkpoint }, deps)).rejects.toThrow('fixture paused before writing')
    expect(state.checkpoint?.stage).toBe('writing')
    await generateInsight({ ...input, checkpoint: state.checkpoint }, deps)
  } else {
    await generateInsight({ ...input, checkpoint }, deps)
  }
  expect(stages).toEqual(['checking', 'compress-navigation', 'writing'])
  expect(state.checkpoint?.checks[0]).toMatchObject({ rounds: 1, state: 'finished', finding })
  expect(state.checkpoint?.observations).toEqual([original])
})

test.each([
  { name: 'omits a fact', code: 'INVALID_INSIGHT_OUTPUT', calls: 2, facts: [preservedMemory.facts[1]] },
  { name: 'invents an input entry', code: 'INVALID_EVIDENCE', calls: 1, facts: [...preservedMemory.facts, { kind: 'fact', text: '伪造', entryIds: ['99:0'] }] },
  { name: 'promotes an unknown without known evidence', code: 'INVALID_EVIDENCE', calls: 1, facts: [
    preservedMemory.facts[0], { kind: 'fact', text: '已知规则。', entryIds: ['2:0'] },
    { kind: 'fact', text: '已确认。', entryIds: ['3:0'] },
  ] },
  { name: 'omits a fact and invents an input entry', code: 'INVALID_EVIDENCE', calls: 1,
    facts: [{ kind: 'fact', text: '伪造', entryIds: ['99:0'] }] },
  { name: 'omits facts and promotes an unknown', code: 'INVALID_EVIDENCE', calls: 1,
    facts: [{ kind: 'fact', text: '已确认。', entryIds: ['3:0'] }] },
  { name: 'downgrades a known fact and promotes an unknown', code: 'INVALID_EVIDENCE', calls: 1, facts: [
    { kind: 'unknown', text: '原文是否说过每次？', entryIds: ['0:0', '1:0'] },
    { kind: 'fact', text: '已确认。', entryIds: ['3:0'] },
  ] },
])('compaction rejects a response that $name', async ({ facts, code, calls }) => {
  const { input, deps, state } = memoryFixture({ ...preservedMemory, facts })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code })
  expect(state.checkpoint?.callsReserved).toBe(calls)
  expect(state.checkpoint?.navigation?.nextRoots).toEqual([])
  expect(state.checkpoint?.navigation?.cursor).toBe(0)
})

test('known plans can remain with their unresolved results in unknown notes without duplicating the known text', async () => {
  const entries = compressionCoverageFixture.entries.map(entry => ({ ...entry, kind: entry.kind as 'fact' | 'unknown' }))
  const ids = [...new Set(entries.flatMap(entry => entry.sourceIds))].sort((a, b) => Number(a) - Number(b))
  const messages = ids.map(id => source(id, true, '合成试验来源 ' + id))
  const response = compressionCoverageFixture.response
  let compressions = 0
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      compressions++
      expect(payload.repair).toBeUndefined()
      expect(state.checkpoint?.navigation?.nextRoots).toEqual([])
      return result(response)
    }
    expect(payload.stage).toBe('writing')
    expect(payload.openThreads).toContainEqual({ text: response.facts[8].text, sourceIds: ['10', '11', '12'] })
    return result(noConclusion)
  })
  deps.countInput = async () => ({ method: 'tokenizer', tokens: 100 })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: messages.length, textOffset: 0 }
  checkpoint.coveredMessageIds = ids
  checkpoint.observations = entries.filter(entry => entry.kind === 'fact').map(({ text, sourceIds }) => ({ text, sourceIds }))
  checkpoint.openThreads = entries.filter(entry => entry.kind === 'unknown').map(({ text, sourceIds }) => ({ text, sourceIds }))
  await generateInsight({ ...input, checkpoint }, deps)
  expect(compressions).toBe(1)
  expect(state.checkpoint?.callsReserved).toBe(2)
})

test.each(compressionMixedKindsFixture.responses)('real response $number retains a confirmed deferral and its unresolved details in one unknown note', async response => {
  const entries = compressionMixedKindsFixture.entries.map(entry => ({ ...entry, kind: entry.kind as 'fact' | 'unknown' }))
  const ids = [...new Set(entries.flatMap(entry => entry.sourceIds))]
  const messages = ids.map(id => source(id, true, '合成试验来源 ' + id))
  const retainedText = response.facts.find(fact => fact.entryIds.includes('17:0'))!.text
  let compressions = 0
  const { input, deps } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      compressions++
      expect(payload.repair).toBeUndefined()
      return result(response)
    }
    expect(payload.openThreads).toContainEqual({ text: retainedText, sourceIds: ['107', '113', '114'] })
    expect([...payload.observations, ...payload.openThreads].map((note: { text: string }) => note.text).sort())
      .toEqual(response.facts.map(fact => fact.text).sort())
    expect(new Set([...payload.observations, ...payload.openThreads].flatMap((note: { sourceIds: string[] }) => note.sourceIds)))
      .toEqual(new Set(ids))
    return result(noConclusion)
  })
  deps.countInput = async () => ({ method: 'tokenizer', tokens: 100 })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: messages.length, textOffset: 0 }
  checkpoint.coveredMessageIds = ids
  checkpoint.observations = entries.filter(entry => entry.kind === 'fact').map(({ text, sourceIds }) => ({ text, sourceIds }))
  checkpoint.openThreads = entries.filter(entry => entry.kind === 'unknown').map(({ text, sourceIds }) => ({ text, sourceIds }))
  checkpoint.navigation = { factsVersion: 2, reconciled: false, cursor: 0, nextRoots: [], repairs: 0,
    roots: entries.map((_entry, index) => index),
    nodes: entries.map(entry => ({ text: entry.text, sourceIds: entry.sourceIds, children: [], facts: [entry] })) }
  await generateInsight({ ...input, checkpoint }, deps)
  expect(compressions).toBe(1)
})

test('reclassifying separate mixed-memory groups as unknown still requires a joint reconciliation', async () => {
  const { input, deps } = memoryFixture()
  input.checkpoint.observations = [
    { text: '采购暂缓。' + '事'.repeat(350), sourceIds: ['1'] },
    { text: '负责人仍未定。' + '事'.repeat(350), sourceIds: ['2'] },
  ]
  input.checkpoint.openThreads = [{ text: '下月安排未发布。' + '事'.repeat(350), sourceIds: ['3'] }]
  let compressions = 0
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.operation === 'compress-navigation'
      ? 100 + 1100 * payload.nodes.flatMap((node: { entries: unknown[] }) => node.entries).length : 100 }
  }
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      compressions++
      const entries = payload.nodes.flatMap((node: { entries: { entryId: string }[] }) => node.entries)
      return result({ text: '安排待定。', facts: [{ kind: 'unknown',
        text: compressions === 1 ? '采购暂缓，负责人未定。' : compressions === 2 ? '下月安排未发布。' : '采购暂缓，负责人未定，下月安排未发布。',
        entryIds: entries.map((entry: { entryId: string }) => entry.entryId) }] })
    }
    expect(compressions).toBe(3)
    expect(payload.observations).toEqual([])
    expect(payload.openThreads).toEqual([{ text: '采购暂缓，负责人未定，下月安排未发布。', sourceIds: ['1', '2', '3'] }])
    return result(noConclusion)
  }
  await generateInsight(input, deps)
})

test('a local kind change cannot use the complete-writer exception before mixed memory is jointly reconciled', async () => {
  const { input, deps, state } = memoryFixture()
  input.checkpoint.observations = [{ text: '已明确暂缓发布。' + '事'.repeat(350), sourceIds: ['1'] }]
  input.checkpoint.openThreads = [{ text: '负责人未定。' + '事'.repeat(350), sourceIds: ['2'] }]
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.operation === 'compress-navigation' && payload.nodes.length > 1 ? 3500 : 100 }
  }
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.operation).toBe('compress-navigation')
    return result({ text: '安排待定。', facts: payload.nodes.flatMap((node: { entries: { text: string; entryId: string }[] }) => node.entries)
      .map((entry: { text: string; entryId: string }) => ({ kind: 'unknown', text: entry.text, entryIds: [entry.entryId] })) })
  }
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(state.checkpoint?.callsReserved).toBe(2)
  expect(state.checkpoint?.navigation).toMatchObject({ cursor: 0, nextRoots: [], repairs: 1 })
})

test.each([undefined, 1] as const)('legacy compressed checkpoints rebuild from retained original notes without erasing spent budget (facts version: %s)', async factsVersion => {
  const { input, deps, state } = memoryFixture(preservedMemory, payload => {
    expect(payload.observations[0].sourceIds).toEqual(['1', '2'])
    expect(payload.openThreads).toEqual([])
  })
  input.checkpoint.navigation = {
    nodes: [{ text: '旧摘要丢失撤回来源。', sourceIds: ['1'], children: [] }],
    roots: [0], cursor: 0, nextRoots: [], repairs: 0, factsVersion,
  }
  input.checkpoint.callsReserved = 1
  input.checkpoint.attempts = [{ stage: 'reading', input: { method: 'tokenizer', tokens: 100 }, reservedOutput: 100,
    startedAtMs: 0, status: 'returned', usage: { inputTokens: 80, outputTokens: 20 } }]
  await generateInsight(input, deps)
  expect(state.checkpoint?.callsReserved).toBe(3)
  expect(state.checkpoint?.attempts[0].usage).toEqual({ inputTokens: 80, outputTokens: 20 })
})

test('same-source facts and unknowns share a small compression window and remain reconciled after writing resumes', async () => {
  const { input, deps, state } = memoryFixture()
  input.snapshot.sources = [input.snapshot.sources[1], input.snapshot.sources[0], ...input.snapshot.sources.slice(2)]
  input.checkpoint.observations = [
    { text: '咖啡渍已向对方说明。' + '事'.repeat(350), sourceIds: ['1'] },
    { text: '已确认带线到现场。' + '事'.repeat(350), sourceIds: ['4', '2'] },
  ]
  input.checkpoint.openThreads = [
    { text: '咖啡渍是否说明尚待核对。', sourceIds: ['1'] },
    { text: '是否把线带到现场尚待核对。', sourceIds: ['2'] },
  ]
  const originals = structuredClone({ observations: input.checkpoint.observations, openThreads: input.checkpoint.openThreads })
  const stages: string[] = []
  let paused = false
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.operation === 'compress-navigation'
      ? 100 + 1100 * payload.nodes.flatMap((node: { entries: unknown[] }) => node.entries).length
      : 100 + Buffer.byteLength(request.prompt) }
  }
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    stages.push(payload.operation ?? payload.stage)
    if (payload.operation === 'compress-navigation') {
      if (stages.length === 3) return result(retainEntries(payload))
      const entries = payload.nodes.flatMap((node: { entries: { kind: string; text: string; entryId: string }[] }) => node.entries)
      expect(entries.map((entry: { kind: string }) => entry.kind)).toEqual(['fact', 'unknown'])
      return result({ text: '核对完成。', facts: [{ kind: 'fact', text: stages.length === 1 ? '已确认带线到现场。' : '咖啡渍已向对方说明。',
        entryIds: entries.map((entry: { entryId: string }) => entry.entryId) }] })
    }
    expect(payload.observations).toEqual([
      { text: '已确认带线到现场。', sourceIds: ['4', '2'] },
      { text: '咖啡渍已向对方说明。', sourceIds: ['1'] },
    ])
    expect(payload.openThreads).toEqual([])
    if (!paused) {
      paused = true
      throw new Error('fixture paused during writing after source-ordered compaction')
    }
    return result(noConclusion)
  }
  await expect(generateInsight(input, deps)).rejects.toThrow('fixture paused during writing after source-ordered compaction')
  expect(state.checkpoint?.callsReserved).toBe(4)
  const compactedNavigation = structuredClone(state.checkpoint?.navigation)
  await generateInsight({ ...input, checkpoint: state.checkpoint }, deps)
  expect(stages).toEqual(['compress-navigation', 'compress-navigation', 'compress-navigation', 'writing', 'writing'])
  expect(state.checkpoint?.callsReserved).toBe(5)
  expect(state.checkpoint?.navigation).toEqual(compactedNavigation)
  expect(state.checkpoint).toMatchObject(originals)
})

test('migrating source-ordered navigation retains an already used compression repair and spent calls', async () => {
  const { input, deps, state } = memoryFixture()
  input.checkpoint.navigation = { factsVersion: 1, reconciled: false, roots: [0], cursor: 0, nextRoots: [], repairs: 1,
    nodes: [{ text: '旧导航。', sourceIds: ['1'], children: [] }] }
  input.checkpoint.callsReserved = 3
  input.checkpoint.attempts = Array.from({ length: 3 }, () => ({ stage: 'reading' as const,
    input: { method: 'tokenizer' as const, tokens: 100 }, reservedOutput: 100, startedAtMs: 0,
    status: 'returned' as const, usage: { inputTokens: 80, outputTokens: 20 } }))
  input.checkpoint.writingRepairs = 1
  let calls = 0
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.operation).toBe('compress-navigation')
    expect(payload.repair).toBe(true)
    calls++
    return result(retainEntries(payload))
  }
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(calls).toBe(1)
  expect(state.checkpoint).toMatchObject({ callsReserved: 4, writingRepairs: 1,
    navigation: { repairs: 1, cursor: 0, nextRoots: [] } })
})

test('facts and an old unknown split across compression requests receive a joint reconciliation before writing', async () => {
  let calls = 0
  const { input, deps } = memoryFixture()
  input.checkpoint.observations = [
    { text: '一年有效，无最低消费。' + '事'.repeat(350), sourceIds: ['1'] },
    { text: '本人已经接受这些条件。' + '事'.repeat(350), sourceIds: ['2'] },
  ]
  input.checkpoint.openThreads = [{ text: '余额条件还没确定。', sourceIds: ['3'] }]
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.operation === 'compress-navigation'
      ? 100 + 1100 * payload.nodes.flatMap((node: { entries: unknown[] }) => node.entries).length
      : 100 + Buffer.byteLength(request.prompt) }
  }
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') {
      calls++
      const entries = payload.nodes.flatMap((node: { entries: { kind: string; entryId: string }[] }) => node.entries)
      const known = entries.some((entry: { kind: string }) => entry.kind === 'fact')
      return result({ text: '余额条款。', facts: [{ kind: known ? 'fact' : 'unknown',
        text: known ? '一年有效、无最低消费，已接受。' : '余额条件尚待确认。',
        entryIds: entries.map((entry: { entryId: string }) => entry.entryId) }] })
    }
    expect(calls).toBe(2)
    expect(payload.openThreads).toEqual([])
    expect(payload.observations).toEqual([{ text: '一年有效、无最低消费，已接受。', sourceIds: ['1', '2', '3'] }])
    return result(noConclusion)
  }
  await generateInsight(input, deps)
})

test.each([undefined, 1] as const)('migrating a legacy tree clears obsolete navigation pointers but retains checked evidence and rounds (facts version: %s)', async factsVersion => {
  const { input, deps, state } = memoryFixture()
  input.checkpoint.stage = 'checking'
  input.checkpoint.navigation = { nodes: [{ text: '旧导航', sourceIds: ['1'], children: [] }], roots: [0], cursor: 0, nextRoots: [], repairs: 0, factsVersion }
  input.checkpoint.checks = [{ id: '1', observation: '确认安排', supportingIds: ['1'], state: 'pending', rounds: 1,
    seenEvidenceIds: ['1'], evidenceNotes: [], navigationRequests: [{ id: 55, offset: 0 }], pendingNavigation: { id: 55, offset: 0 },
    pendingIds: ['1'], pendingCursor: { messageIndex: 1, textOffset: 0 }, pendingThrough: null, shrinkDepth: 0, repairs: 0,
    purpose: '核对旧来源', finding: null }]
  const priorRun = deps.run
  deps.run = async (request, context) => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage !== 'checking') return priorRun(request, context)
    expect(payload.check.round).toBe(2)
    expect(payload.earlierEvidence.map((message: InsightSourceMessage) => message.id)).toEqual(['1'])
    expect(payload.navigationPage).toBeNull()
    return result({ action: 'finish', checkId: '1', revisedObservation: '原话已读取。', supportingIds: ['1'], counterexampleIds: [], limitations: [] })
  }
  await generateInsight(input, deps)
  expect(state.checkpoint?.checks[0].navigationRequests).toEqual([])
  expect(state.checkpoint?.checks[0].seenEvidenceIds).toEqual(['1'])
  expect(state.checkpoint?.checks[0].rounds).toBe(2)
})

test('unshrinking fact memory stops at the original capacity without deleting facts or asking the writer', async () => {
  const { input, deps, state } = memoryFixture()
  let calls = 0
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.operation).toBe('compress-navigation')
    calls++
    return result(retainEntries(payload))
  }
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(calls).toBe(2)
  expect(state.checkpoint?.observations).toHaveLength(3)
  expect(state.checkpoint?.openThreads).toHaveLength(1)
})

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

test('an interrupted older insight rereads only the unfinished message when body anonymization changes', async () => {
  const messages = [source('1', true, '已读内容'), source('2', false, '小陈说明天见。')]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'writing') return result(noConclusion)
    expect(payload.messages).toEqual([messages[1]])
    return result(noObservations)
  })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  delete checkpoint.sourceTextVersion
  checkpoint.coveredMessageIds = ['1']
  checkpoint.cursor = { messageIndex: 1, textOffset: 3 }
  checkpoint.pendingRead = { from: checkpoint.cursor, to: { messageIndex: 2, textOffset: 0 }, depth: 0, repairs: 0 }
  await generateInsight({ ...input, checkpoint }, deps)
  expect(state.checkpoint?.coveredMessageIds).toEqual(['1', '2'])
})

test('later reading requests redact complete candidate fields before shortening their previews', async () => {
  const messages = ['1', '2', '3'].map(id => source(id, true, 'x'.repeat(4500)))
  const assignment = 'password="Blue Bird 42!"' + '。'.repeat(20)
  const observation = '甲'.repeat(217) + assignment
  const reason = '乙'.repeat(157) + assignment
  const revisedObservation = '丙'.repeat(217) + assignment
  const protectedTail = 'password="[密码]"' + '。'.repeat(8)
  const batches: string[][] = []
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'writing') return result(noConclusion)
    const ids = payload.messages.map((message: InsightSourceMessage) => message.id)
    batches.push(ids)
    if (ids[0] === '1') return result({ ...noObservations, candidates: [{ observation, reason, supportingIds: ['1'] }] })
    if (ids[0] === '2') {
      expect(payload.knownCandidates[0]).toMatchObject({
        observation: '甲'.repeat(217) + protectedTail, reason: '乙'.repeat(157) + protectedTail,
      })
      return result({ ...noObservations, candidateUpdates: [{ id: '1', action: 'resolve', finding: {
        revisedObservation, supportingIds: ['2'], counterexampleIds: [], limitations: [],
      } }] })
    }
    expect(payload.knownCandidates[0].finding.revisedObservation).toBe('丙'.repeat(217) + protectedTail)
    return result(noObservations)
  })
  deps.prepareNotes = createMessageProcessor(defaultProcessing, []).data
  await generateInsight({ ...input, model: { ...model, maxInputTokens: 8000 } }, deps)
  expect(batches).toEqual([['1'], ['2'], ['3']])
  expect(state.writes.some(checkpoint => checkpoint.checks[0]?.reason === reason)).toBe(true)
  expect(state.checkpoint?.checks[0]).toMatchObject({ observation, finding: { revisedObservation } })
})

test('reading keeps independent candidates backed by the same message while skipping a repeated question', async () => {
  const { input, deps, state } = setup([source('1', true, '刚才我先道歉了，这次聚会也由我安排。')], async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({ ...noObservations, candidates: [
      { observation: '是否总由本人先道歉？', supportingIds: ['1'], reason: '核对其他冲突由谁先道歉。' },
      { observation: '是否总由本人 先道歉？', supportingIds: ['1'], reason: '核对其他冲突由谁先道歉。' },
      { observation: '是否总由本人安排聚会？', supportingIds: ['1'], reason: '核对其他聚会的分工。' },
    ] })
    if (payload.stage === 'checking') return result({
      action: 'finish', checkId: payload.check.id, revisedObservation: payload.check.observation,
      supportingIds: ['1'], counterexampleIds: [], alternativeExplanations: [], limitations: ['只能确认这一次。'],
    })
    return result(noConclusion)
  })
  await generateInsight(input, deps)
  expect(state.checkpoint?.checks.map(check => ({ observation: check.observation, state: check.state, finding: check.finding }))).toEqual([
    { observation: '是否总由本人先道歉？', state: 'finished', finding: {
      revisedObservation: '是否总由本人先道歉？', supportingIds: ['1'], counterexampleIds: [],
      alternativeExplanations: [], limitations: ['只能确认这一次。'],
    } },
    { observation: '是否总由本人安排聚会？', state: 'finished', finding: {
      revisedObservation: '是否总由本人安排聚会？', supportingIds: ['1'], counterexampleIds: [],
      alternativeExplanations: [], limitations: ['只能确认这一次。'],
    } },
  ])
})

test('shared-source candidates keep the check limit and spent rounds when writing resumes', async () => {
  const stages: string[] = []
  let writingFailed = false
  const { input, deps, state } = setup([source('1', true, '刚才我先道歉了，这次聚会由我安排，场地还没订。')], async request => {
    const payload = JSON.parse(request.prompt)
    stages.push(payload.stage)
    if (payload.stage === 'reading') return result({ ...noObservations, candidates: [
      { observation: '是否总由本人先道歉？', supportingIds: ['1'] },
      { observation: '是否总由本人安排聚会？', supportingIds: ['1'] },
      { observation: '场地是否已经订好？', supportingIds: ['1'] },
    ] })
    if (payload.stage === 'checking') return result({
      action: 'finish', checkId: payload.check.id, revisedObservation: payload.check.observation,
      supportingIds: ['1'], counterexampleIds: [], alternativeExplanations: [], limitations: ['只能确认这一次。'],
    })
    if (!writingFailed) {
      writingFailed = true
      throw new Error('fixture interruption after shared-source checks')
    }
    return result(noConclusion)
  })
  const configured = { ...input, limits: { ...limits, maxChecks: 2, maxCalls: 5 } }
  await expect(generateInsight(configured, deps)).rejects.toThrow('fixture interruption after shared-source checks')
  expect(state.checkpoint?.checks.map(check => ({ id: check.id, observation: check.observation, state: check.state, rounds: check.rounds })))
    .toEqual([
      { id: '1', observation: '是否总由本人先道歉？', state: 'finished', rounds: 1 },
      { id: '2', observation: '是否总由本人安排聚会？', state: 'finished', rounds: 1 },
    ])
  const savedChecks = structuredClone(state.checkpoint?.checks)
  await generateInsight({ ...configured, checkpoint: state.checkpoint }, deps)
  expect(state.checkpoint?.checks).toEqual(savedChecks)
  expect(state.checkpoint?.callsReserved).toBe(5)
  expect(stages).toEqual(['reading', 'checking', 'checking', 'writing', 'writing'])
})

test('reading a later correction settles a candidate without a separate check and keeps the counterexample citable after recovery', async () => {
  const messages = [paddedSource('1', true, previousArrangement), source('2', false, '这次事情碰在一起。'),
    source('3', false, lastMonthArrangement + 'x'.repeat(1000), '1'), source('4', true, acknowledgeArrangement, '3')]
  const stages: string[] = []
  let writingFailed = false
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    stages.push(payload.stage)
    if (payload.stage === 'reading' && payload.messages[0].id === '1') {
      return result({ ...noObservations, candidates: [arrangementCandidate] })
    }
    if (payload.stage === 'reading') {
      expect(payload.messages.map(({ id }: InsightSourceMessage) => id)).toEqual(['3', '4'])
      expect(payload.knownCandidates[0]).toMatchObject({
        id: '1', state: 'pending', reason: '核对其他月份由谁订场地。', evidenceNotes: [{
          ...arrangementNote, sentAtMs: messages[0].sentAtMs, senderName: '本人', isSelf: true, replyToMessageId: null,
        }],
      })
      return result({ ...noObservations, candidateUpdates: [
        { id: '1', action: 'resolve', finding: arrangementFinding, evidenceNotes: [] },
      ] })
    }
    expect(payload.stage).toBe('writing')
    expect(payload.checks[0]).toMatchObject({ id: '1', state: 'finished', finding: arrangementFinding })
    expect(payload.checks[0]).not.toHaveProperty('observation')
    if (!writingFailed) {
      writingFailed = true
      throw new Error('fixture interruption during writing')
    }
    return result({
      ...noConclusion,
      relationship: [{ content: [{ text: 'ta 上个月订了场地，你随后修正了每次的说法。', citationId: 'last-month' }] }],
      citations: [{ id: 'last-month', fragments: [{ messageIds: ['3', '4'] }] }],
    })
  })
  const configured = { ...input, limits: { ...limits, maxCalls: 4 } }
  await expect(generateInsight(configured, deps)).rejects.toThrow('fixture interruption during writing')
  expect(state.checkpoint).toMatchObject({ callsReserved: 3, checks: [{ id: '1', state: 'finished', rounds: 0, finding: arrangementFinding }] })
  const report = await generateInsight({ ...configured, checkpoint: state.checkpoint }, deps)
  expect(stages).toEqual(['reading', 'reading', 'writing', 'writing'])
  expect(state.checkpoint?.callsReserved).toBe(4)
  expect(report.citations[0].fragments[0].sources).toEqual([{ messageId: '3', revision: 'rev-3' }, { messageId: '4', revision: 'rev-4' }])
})

test('reading can revise a candidate, settle it, and reopen the same record when new evidence requires a check', async () => {
  const revisionReason = '核对上个月是否同时安排了场地和餐饮。'
  const reopenedReason = '回读原约定，确认订餐是否也在分工内。'
  const revisedFinding = { ...arrangementFinding, revisedObservation: '对方只回了场地消息，后文确认上月场地由对方负责。', supportingIds: ['2'] }
  const messages = [paddedSource('1', true, previousArrangement), paddedSource('2', false, '上月我只回复了场地那条消息。', '1'),
    source('3', false, lastMonthArrangement + 'x'.repeat(1000), '2'), source('4', true, acknowledgeArrangement, '3'),
    paddedSource('5', true, '本月餐饮临时换人，需要看起初说的是场地还是全部。')]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') {
      const firstId = payload.messages[0].id
      if (firstId === '1') return result({ ...noObservations, candidates: [arrangementCandidate] })
      const candidate = payload.knownCandidates.find((item: { id: string }) => item.id === '1')
      if (firstId === '2') return result({ ...noObservations, candidateUpdates: [{
        id: '1', action: 'revise', observation: '安排范围是订场地还是包含餐饮？', supportingIds: ['2'],
        reason: revisionReason, evidenceNotes: [{ sourceId: '2', quote: '上月我只回复了场地那条消息。', text: '回应仅限场地。' }],
      }] })
      if (firstId === '3') {
        expect(candidate).toMatchObject({ id: '1', state: 'pending', reason: revisionReason })
        return result({ ...noObservations, candidateUpdates: [
          { id: '1', action: 'resolve', finding: revisedFinding, evidenceNotes: [] },
        ] })
      }
      expect(firstId).toBe('5')
      expect(candidate).toMatchObject({ id: '1', state: 'finished', finding: { revisedObservation: revisedFinding.revisedObservation } })
      return result({ ...noObservations, candidateUpdates: [{
        id: '1', action: 'revise', observation: '核对之前的分工是否涉及餐饮。', supportingIds: ['5'],
        reason: reopenedReason, evidenceNotes: [],
      }] })
    }
    if (payload.stage === 'checking') {
      expect(payload.check).toMatchObject({ id: '1', round: 1, observation: '核对之前的分工是否涉及餐饮。', purpose: reopenedReason })
      expect(payload.evidence.map(({ id }: InsightSourceMessage) => id)).toEqual(['5'])
      expect(payload.evidenceNotes).toContainEqual(expect.objectContaining(arrangementNote))
      return result({ action: 'finish', checkId: '1', revisedObservation: '只能确认场地安排，餐饮分工未知。',
        supportingIds: ['1', '5'], counterexampleIds: [], alternativeExplanations: [], limitations: ['未见餐饮原约定。'] })
    }
    return result(noConclusion)
  })
  await generateInsight({ ...input, limits: { ...limits, maxChecks: 1 } }, deps)
  expect(state.checkpoint?.checks).toMatchObject([{ id: '1', rounds: 1, reason: reopenedReason,
    finding: { revisedObservation: '只能确认场地安排，餐饮分工未知。', supportingIds: ['1', '5'], counterexampleIds: [] } }])
})

test('candidate packing reserves room for a related earlier candidate even when raw messages would fill the request', async () => {
  const messages = [source('1', true, '分工原话' + 'x'.repeat(450)), source('2', true, '无关议题'),
    source('3', false, '现在是轮流安排' + 'x'.repeat(2250), '1')]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage !== 'reading') return result(noConclusion)
    if (payload.messages[0].id === '1') return result({ ...noObservations, candidates: [
      { observation: '分工是否轮换？', supportingIds: ['1'], reason: '核对谁安排下一场。' },
    ] })
    expect(payload.knownCandidates[0]).toMatchObject({ id: '1', observation: '分工是否轮换？' })
    expect((await deps.countInput!(request, request.model)).tokens).toBeLessThanOrEqual(2944)
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
    if (!payload.messages[0].text.startsWith('现在是轮流安排')) return result(noObservations)
    return result({ ...noObservations, candidateUpdates: [{
      id: '1', action: 'resolve', finding: { ...arrangementFinding, supportingIds: [], counterexampleIds: ['3'] }, evidenceNotes: [],
    }] })
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ citations: [] })
  expect(state.checkpoint?.checks).toMatchObject([{ id: '1', state: 'finished', rounds: 0 }])
})

test.each(['unknown ID', 'hidden source', 'forged quote'])('reading rejects an update with a %s', async fault => {
  const messages = [paddedSource('1', true, previousArrangement), source('2', false, '未发送给后续阅读的原文。'),
    paddedSource('3', false, lastMonthArrangement), source('4', true, acknowledgeArrangement)]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading' && payload.messages[0].id === '1') {
      return result({ ...noObservations, candidates: [arrangementCandidate] })
    }
    if (payload.stage !== 'reading') return result(noConclusion)
    return result({ ...noObservations, candidateUpdates: [{
      id: fault === 'unknown ID' ? '99' : '1', action: 'resolve',
      finding: { ...arrangementFinding, supportingIds: fault === 'hidden source' ? ['2'] : ['1'] },
      evidenceNotes: fault === 'forged quote' ? [{ sourceId: '3', quote: '上个月没人负责。', text: '虚构的摘录。' }] : [],
    }] })
  })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint).toMatchObject({ coveredMessageIds: ['1', '2'], checks: [{ id: '1', state: 'pending', finding: null }] })
})

test('reading cannot update a real candidate whose record did not fit in the request', async () => {
  const messages = [source('1', true, '首个议题' + 'x'.repeat(450)), source('2', true, '另一个议题' + 'y'.repeat(450)),
    paddedSource('3', false, '后续回复', '1')]
  const readingStages: string[] = []
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    readingStages.push(payload.stage)
    if (payload.stage !== 'reading') return result(noConclusion)
    if (payload.messages[0].id === '1') return result({ ...noObservations, candidates: [
      { observation: '第一个问题。', supportingIds: ['1'] },
      { observation: '第二个问题。', supportingIds: ['2'] },
    ] })
    expect(payload.knownCandidates[0]).toMatchObject({ id: '1' })
    expect(payload.knownCandidates.every((candidate: { id?: string }) => candidate.id !== '2')).toBe(true)
    return result({ ...noObservations, candidateUpdates: [{ id: '2', action: 'resolve', finding: {
      ...arrangementFinding, supportingIds: ['3'], counterexampleIds: [],
    }, evidenceNotes: [] }] })
  })
  // This model fits one candidate and the new source, but two candidate records exceed its limit.
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: 100 + 520 * (payload.knownCandidates?.length ?? 0)
      + Buffer.byteLength(JSON.stringify(payload.messages ?? [])) }
  }
  await expect(generateInsight({ ...input, model: { ...model, maxInputTokens: 2500 } }, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(readingStages).toEqual(['reading', 'reading'])
  expect(state.checkpoint?.checks).toHaveLength(2)
})

test('checking cannot cite covered sources that the request received neither as original text nor as verified quotes', async () => {
  const messages = [source('1', true, previousArrangement), source('2', false, '尚未提供给核查的原文。')]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({ ...noObservations, candidates: [arrangementCandidate] })
    expect(payload.stage).toBe('checking')
    expect(payload.evidence.map(({ id }: InsightSourceMessage) => id)).toEqual(['1'])
    expect(payload.evidenceNotes).toContainEqual(expect.objectContaining(arrangementNote))
    return result({ action: 'finish', checkId: '1', ...arrangementFinding, counterexampleIds: ['2'] })
  })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint).toMatchObject({ coveredMessageIds: ['1', '2'], checks: [{ state: 'pending', finding: null }] })
})

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
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
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
  const report = await generateInsight({ ...input, limits: { ...limits, maxCalls: 12 } }, deps)
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
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
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

function laterThreadReply(response: unknown, sharedSource = false) {
  const messages = [source('1', true, sharedSource ? '还没吃午饭，台灯也还没取。' : '还没吃午饭。'),
    source('2', false, '台灯稍后取。'), source('3', true, '已经吃到饭了。')]
  const visible = { text: '是否已吃午饭？', sourceIds: ['1'] }
  const hidden = { text: '未发送事项：台灯是否取回？', sourceIds: [sharedSource ? '1' : '2'] }
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
    if (payload.stage !== 'reading') return result(noConclusion)
    if (payload.messages[0].id === '1') {
      expect(payload.messages.map((message: InsightSourceMessage) => message.id)).toEqual(['1', '2'])
      return result({ ...noObservations, openThreads: [hidden, visible] })
    }
    expect(payload.messages.map((message: InsightSourceMessage) => message.id)).toEqual(['3'])
    expect(payload.relatedMessages).toEqual([])
    expect(payload.openThreads).toEqual([visible])
    return result(response)
  })
  // 旧原文及较长事项装不下，短事项仍可用于后续状态更新。
  deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage !== 'reading') return { method: 'tokenizer', tokens: 100 }
    return { method: 'tokenizer', tokens: 100
      + (payload.messages ?? []).reduce((sum: number, message: InsightSourceMessage) => sum + (message.id === '3' ? 900 : 450), 0)
      + 10000 * (payload.relatedMessages?.length ?? 0)
      + (payload.openThreads ?? []).reduce((sum: number, note: { text: string }) => sum + (note.text.startsWith('未发送事项') ? 1800 : 100), 0) }
  }
  return { input: { ...input, model: { ...model, maxInputTokens: 1700 } }, deps, state, hidden }
}

test('a later answer resolves a visible earlier thread without requiring its original text again', async () => {
  const { input, deps, state, hidden } = laterThreadReply({
    ...noObservations, observations: [{ text: '本人已经吃过饭。', sourceIds: ['3'] }], resolvedThreadSourceIds: ['1'],
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
  expect(state.checkpoint?.openThreads).toEqual([hidden])
  expect(state.checkpoint?.coveredMessageIds).toEqual(['1', '2', '3'])
})

test('resolving a visible old thread preserves an undisplayed thread with the same source', async () => {
  const { input, deps, state, hidden } = laterThreadReply({ ...noObservations, resolvedThreadSourceIds: ['1'] }, true)
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
  expect(state.checkpoint?.openThreads).toEqual([hidden])
})

test.each([{ ids: ['1'] }, { ids: ['1', '3'] }])('a repeated visible old thread $ids is repaired once without admitting its old sources as new evidence', async ({ ids }) => {
  const { input, deps, state } = laterThreadReply({ ...noObservations, openThreads: [{ text: '复述旧午饭事项。', sourceIds: ids }] })
  const priorRun = deps.run
  let attempts = 0
  deps.run = async (request, context) => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading' && !payload.operation && payload.messages[0].id === '3') {
      attempts++
      if (attempts === 2) {
        expect(payload.repair).toBe(true)
        return result({ ...noObservations, openThreads: [{ text: '饭后是否已休息仍未知。', sourceIds: ['3'] }] })
      }
    }
    return priorRun(request, context)
  }
  await generateInsight(input, deps)
  expect(attempts).toBe(2)
  expect(state.checkpoint?.openThreads).toContainEqual({ text: '饭后是否已休息仍未知。', sourceIds: ['3'] })
  expect(state.checkpoint?.openThreads.some(note => note.text === '复述旧午饭事项。')).toBe(false)
})

test('a second repeated old thread fails after the single reading repair without altering stored notes', async () => {
  const { input, deps, state } = laterThreadReply({ ...noObservations, openThreads: [{ text: '复述旧事项。', sourceIds: ['1'] }] })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(state.checkpoint?.attempts.filter(attempt => attempt.stage === 'reading')).toHaveLength(3)
  expect(state.checkpoint?.openThreads.some(note => note.text === '复述旧事项。')).toBe(false)
})

function readingFindingFixture(response: (attempt: number) => unknown) {
  const messages = [source('1', true, previousArrangement), source('2', false, lastMonthArrangement),
    source('3', true, acknowledgeArrangement)]
  let attempts = 0
  const fixture = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result(response(++attempts))
    expect(payload.stage).toBe('writing')
    return result(noConclusion)
  })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: 1, textOffset: 0 }
  checkpoint.coveredMessageIds = ['1']
  checkpoint.checks = [{ id: '1', observation: '是否每次都是本人安排？', supportingIds: ['1'], state: 'pending', rounds: 0,
    seenEvidenceIds: [], evidenceNotes: [arrangementNote], navigationRequests: [], pendingNavigation: null,
    pendingIds: ['1'], pendingCursor: { messageIndex: 0, textOffset: 0 }, pendingThrough: null, shrinkDepth: 0, repairs: 0,
    purpose: '核对历史分工', finding: null }]
  return { ...fixture, input: { ...fixture.input, checkpoint }, attempts: () => attempts }
}

const overlappingFinding = {
  revisedObservation: '本人撤回每次都由自己安排，保留本次疲惫。', supportingIds: ['1', '3'], counterexampleIds: ['2', '3'],
  alternativeExplanations: [], limitations: [],
}
const readingResolution = (finding = overlappingFinding) => ({ ...noObservations,
  candidateUpdates: [{ id: '1', action: 'resolve', finding, evidenceNotes: [] }],
})

test('a valid-source overlap in a reading finding receives one repair and then resolves the same candidate', async () => {
  const { input, deps, state, attempts } = readingFindingFixture(attempt => readingResolution(
    attempt === 1 ? overlappingFinding : { ...overlappingFinding, counterexampleIds: ['2'] },
  ))
  await generateInsight(input, deps)
  expect(attempts()).toBe(2)
  expect(state.checkpoint?.checks).toMatchObject([{ id: '1', state: 'finished', rounds: 0,
    finding: { supportingIds: ['1', '3'], counterexampleIds: ['2'] } }])
})

test('an unrepaired finding overlap stops after one repair without accepting the candidate update', async () => {
  const { input, deps, state, attempts } = readingFindingFixture(() => readingResolution())
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
  expect(attempts()).toBe(2)
  expect(state.checkpoint?.checks[0]).toMatchObject({ state: 'pending', finding: null })
})

test('a finding overlap cannot hide an illegal source later in the reading response', async () => {
  const { input, deps, attempts } = readingFindingFixture(() => ({ ...readingResolution(),
    observations: [{ text: '陌生来源。', sourceIds: ['99'] }],
  }))
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(attempts()).toBe(1)
})

test('checking repairs overlapping valid evidence roles without changing its existing round limit', async () => {
  let checks = 0
  const { input, deps, state } = setup([source('1', true, previousArrangement)], async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({ ...noObservations, candidates: [arrangementCandidate] })
    if (payload.stage === 'checking') return result({ action: 'finish', checkId: '1',
      revisedObservation: '只能确认本人陈述疲惫。', supportingIds: ['1'], counterexampleIds: ++checks === 1 ? ['1'] : [],
      alternativeExplanations: [], limitations: [],
    })
    return result(noConclusion)
  })
  await generateInsight(input, deps)
  expect(checks).toBe(2)
  expect(state.checkpoint?.checks[0]).toMatchObject({ rounds: 2, state: 'finished', finding: { supportingIds: ['1'], counterexampleIds: [] } })
})

test('a shared visible source cannot close two different old unknowns when only one has an answer', async () => {
  const messages = [source('1', true, '还没吃午饭，也没取台灯。'), source('2', true, '已经吃完午饭了。')]
  const lunch = { text: '是否吃过午饭？', sourceIds: ['1'] }
  const lamp = { text: '台灯是否已取回？', sourceIds: ['1'] }
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
    if (payload.stage === 'reading') {
      expect(payload.openThreads).toEqual([lunch, lamp])
      return result({ ...noObservations, observations: [{ text: '本人已经吃完午饭。', sourceIds: ['2'] }], resolvedThreadSourceIds: ['1'] })
    }
    expect(payload.openThreads).toContainEqual(lamp)
    return result(noConclusion)
  })
  const checkpoint = createInsightCheckpoint('7', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: 1, textOffset: 0 }
  checkpoint.coveredMessageIds = ['1']
  checkpoint.openThreads = [lunch, lamp]
  await generateInsight({ ...input, checkpoint }, deps)
  expect(state.checkpoint?.openThreads).toEqual([lunch, lamp])
})

test.each(['unknown-thread', 'invalid-candidate'])('a repeated old thread cannot hide %s and cause a repair request', async kind => {
  const response = { ...noObservations,
    openThreads: [{ text: '复述旧事项。', sourceIds: ['1'] },
      ...(kind === 'unknown-thread' ? [{ text: '陌生来源。', sourceIds: ['99'] }] : [])],
    candidates: kind === 'invalid-candidate' ? [{ observation: '旧事项被当作新证据。', supportingIds: ['1'] }] : [],
  }
  const { input, deps, state } = laterThreadReply(response)
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint?.attempts.filter(attempt => attempt.stage === 'reading')).toHaveLength(2)
})

test.each(['2', '99'])('reading cannot resolve an undisplayed earlier thread or unknown source %s', async id => {
  const { input, deps, state } = laterThreadReply({ ...noObservations, resolvedThreadSourceIds: [id] })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint?.openThreads).toHaveLength(2)
})

test.each([
  { field: 'observations', code: 'INVALID_EVIDENCE' }, { field: 'openThreads', code: 'INVALID_INSIGHT_OUTPUT' },
  { field: 'candidates', code: 'INVALID_EVIDENCE' },
])('a visible old thread does not authorize new $field to cite its missing original', async ({ field, code }) => {
  const value = field === 'candidates' ? { observation: '本人已经吃过饭。', supportingIds: ['1'] }
    : { text: '本人已经吃过饭。', sourceIds: ['1'] }
  const { input, deps } = laterThreadReply({ ...noObservations, [field]: [value], resolvedThreadSourceIds: ['1'] })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code })
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
    if (payload.stage === 'checking' && payload.check.round === 1) {
      const note = payload.observations.find((item: { sourceIds: string[] }) => item.sourceIds.includes('19'))
      return result({ action: 'navigate', checkId: payload.check.id, navigationId: note.navigationId, offset: 0,
        evidenceNotes: [{ sourceId: '2', quote: '每次都等着我来安排，想到这些就有点累。', text: '不能据此确认长期分工。' }],
      })
    }
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
      if (payload.check.round === 2) {
        expect(payload.earlierEvidence.map((message: InsightSourceMessage) => message.text)).toEqual(['首句'])
        expect(payload.evidence.map((message: InsightSourceMessage) => message.text)).toEqual(['后句'])
      }
      return result(action === 'read'
        ? { action, checkId: payload.check.id, messageIds: payload.check.round === 2 ? ['1', '2'] : ['2'], purpose: '需要再看' }
        : { action, checkId: payload.check.id, navigationId: 0, offset: 0 })
    }
    expect(payload.checks[0]).toMatchObject({ state: 'inconclusive', finding: null })
    return result(noConclusion)
  })
  await expect(generateInsight(input, deps)).resolves.toMatchObject({ judgments: [] })
  expect(state.reads.filter(ids => ids.length === 1 && ids[0] === '2')).toHaveLength(1)
  expect(state.checkpoint?.checks[0].rounds).toBe(2)
})

test('checking rereads a source when the current request includes only an earlier quote', async () => {
  const messages = [source('1', true, '我安排场地，但餐饮由你负责。'), source('2', false, '那天你也订餐了。')]
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({ ...noObservations, candidates: [
      { observation: '实际分工是什么？', supportingIds: ['1'], reason: '核对餐饮是否属于本人分工。' },
    ] })
    if (payload.stage !== 'checking') return result(noConclusion)
    if (payload.check.round === 1) return result({ action: 'read', checkId: '1', messageIds: ['2'], purpose: '查看实际订餐情况。',
      evidenceNotes: [{ sourceId: '1', quote: '我安排场地', text: '本人安排场地。' }] })
    if (payload.check.round === 2) {
      expect(payload.evidence.map(({ id }: InsightSourceMessage) => id)).toEqual(['2'])
      expect(payload.earlierEvidence).toEqual([])
      expect(payload.evidenceNotes[0].quote).toBe('我安排场地')
      return result({ action: 'read', checkId: '1', messageIds: ['1'], purpose: '核对分工是否包含餐饮。' })
    }
    expect(payload.evidence.map(({ text }: InsightSourceMessage) => text)).toEqual(['我安排场地，但餐饮由你负责。'])
    return result({ action: 'finish', checkId: '1', revisedObservation: '原分工由对方负责餐饮，当日订餐与分工不同。',
      supportingIds: ['1', '2'], counterexampleIds: [], limitations: ['仅限该次聚会。'], alternativeExplanations: [] })
  })
  await generateInsight({ ...input, limits: { ...limits, maxRoundsPerCheck: 4 } }, deps)
  expect(state.reads.filter(ids => ids.join(',') === '1')).toHaveLength(2)
  expect(state.checkpoint?.checks[0]).toMatchObject({ state: 'finished', rounds: 3,
    finding: { revisedObservation: '原分工由对方负责餐饮，当日订餐与分工不同。' } })
})

test('a quote-only reread added during a fragment preserves the unfinished queue and offset across recovery', async () => {
  const messages = [source('1', true, '我安排场地，但餐饮由你负责。'), source('2', false, '这里是订餐记录。' + 'x'.repeat(580)),
    source('3', true, '订餐结束。')]
  let firstFragment = ''
  const { input, deps, state } = setup(messages, async request => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage === 'reading') return result({ ...noObservations, candidates: [
      { observation: '需要核对餐饮分工。', supportingIds: ['1'] },
    ] })
    if (payload.stage !== 'checking') return result(noConclusion)
    if (payload.check.round === 1) return result({ action: 'read', checkId: '1', messageIds: ['2', '3'], purpose: '看订餐记录。',
      evidenceNotes: [{ sourceId: '1', quote: '我安排场地', text: '本人安排场地。' }] })
    if (payload.check.round === 2) {
      expect(payload.hasMoreEvidence).toBe(true)
      expect(payload.evidence.map(({ id }: InsightSourceMessage) => id)).toEqual(['2'])
      firstFragment = payload.evidence[0].text
      return result({ action: 'read', checkId: '1', messageIds: ['1'], purpose: '查原分工是否另有餐饮约定。',
        evidenceNotes: [{ sourceId: '2', quote: '这里是订餐记录。', text: '此条为订餐记录。' }] })
    }
    if (payload.check.round === 3) throw new Error('fixture interruption during fragment reread')
    expect(payload.evidence.map(({ id }: InsightSourceMessage) => id)).toEqual(['2', '3', '1'])
    expect(firstFragment + payload.evidence[0].text).toBe(messages[1].text)
    expect(payload.evidence[2].text).toBe('我安排场地，但餐饮由你负责。')
    return result({ action: 'finish', checkId: '1', revisedObservation: '原约定由对方负责餐饮。',
      supportingIds: ['1', '2', '3'], counterexampleIds: [], limitations: ['仅限该次聚会。'], alternativeExplanations: [] })
  })
  const fixtureCount = deps.countInput!
  deps.countInput = async (request, configuredModel) => {
    const payload = JSON.parse(request.prompt)
    if (payload.stage !== 'checking') return fixtureCount(request, configuredModel)
    const tokens = payload.evidence.reduce((total: number, part: InsightSourceMessage) => total + part.text.length + 60, 2500)
    return { method: 'tokenizer', tokens }
  }
  const configured = { ...input, limits: { ...limits, maxRoundsPerCheck: 4 } }
  await expect(generateInsight(configured, deps)).rejects.toThrow('fixture interruption during fragment reread')
  expect(firstFragment).not.toBe('')
  expect(state.checkpoint?.checks[0]).toMatchObject({
    pendingIds: ['2', '3', '1'], pendingCursor: { messageIndex: 0, textOffset: firstFragment.length }, rounds: 3,
  })
  await generateInsight({ ...configured, checkpoint: state.checkpoint }, deps)
  expect(state.checkpoint?.checks[0]).toMatchObject({ state: 'finished', rounds: 4 })
  expect(state.checkpoint?.callsReserved).toBe(6)
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

test.each([false, true])('a model timeout is retryable only once and cancellation stops the retry (cancel=%s)', async cancel => {
  let requests = 0
  const controller = new AbortController()
  const { input, deps, state } = setup([source('1', true, '正文')], async () => {
    requests++
    if (cancel) controller.abort()
    throw Object.assign(new Error('timeout'), { code: 'MODEL_TIMEOUT' })
  })
  deps.signal = controller.signal
  await expect(generateInsight(input, deps)).rejects.toMatchObject(cancel ? { name: 'AbortError' } : { code: 'MODEL_TIMEOUT' })
  expect(requests).toBe(cancel ? 1 : 2)
  expect(state.checkpoint?.attempts.map(attempt => attempt.status)).toEqual(cancel ? ['failed'] : ['failed', 'failed'])
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
    if (payload.operation === 'compress-navigation') return result(retainEntries(payload))
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
      expect(request.systemPrompt).not.toContain('observations:[')
      expect(request.systemPrompt).not.toContain('openThreads:[')
      expect(request.systemPrompt).not.toContain('candidates:[')
      return result({ text: '本段合成观察。', facts: [{ kind: 'fact', text: '本段合成观察。',
        entryIds: payload.nodes.flatMap((node: { entries: { entryId: string }[] }) => node.entries.map(entry => entry.entryId)) }] })
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
  await expect(generateInsight({ ...input, limits: { ...limits, maxCalls: 20 } }, deps)).resolves.toMatchObject({ format: 'conversation-insights-v1' })
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
      for (const node of payload.nodes) if (!node.childCount) condensedLeafIds.add(node.entries[0].entryId)
      const entries = payload.nodes.flatMap((node: { entries: { entryId: string; text: string }[] }) => node.entries)
      const middle = entries.filter((entry: { text: string }) => entry.text.includes(marker))
      const ordinary = entries.filter((entry: { text: string }) => !entry.text.includes(marker))
      return result({ text: middle.length ? marker : '本段合成记录。', facts: [
        ...(middle.length ? [{ kind: 'fact', text: marker, entryIds: middle.map((entry: { entryId: string }) => entry.entryId) }] : []),
        ...(ordinary.length ? [{ kind: 'fact', text: '本段合成记录。', entryIds: ordinary.map((entry: { entryId: string }) => entry.entryId) }] : []),
      ] })
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

test.each([1_800_000, 1_800_001])('reuses a saved report after final persistence fails with elapsed time %d ms', async elapsedMs => {
  let dispatched = 0
  const { input, deps, state } = setup([source('1', true, '正文')], async request => {
    dispatched++
    return result(JSON.parse(request.prompt).stage === 'reading' ? noObservations : noConclusion)
  })
  deps.now = () => 1000
  const configured = { ...input, limits: { ...limits, maxElapsedMs: 1_800_000 } }
  const report = await generateInsight(configured, deps)

  const retry = { ...configured, checkpoint: state.checkpoint, elapsedMs }
  await expect(generateInsight(retry, deps)).resolves.toEqual(report)
  expect(dispatched).toBe(2)
})

test.each([
  { condition: 'checkpoint identity changed', error: { code: 'INVALID_INSIGHT_CHECKPOINT' } },
  { condition: 'covered sources do not match the reading cursor', error: { code: 'INVALID_INSIGHT_CHECKPOINT' } },
  { condition: 'a frozen source revision changed', error: { code: 'INVALID_EVIDENCE' } },
  { condition: 'the retry is cancelled during source validation', error: { name: 'AbortError' } },
])('a saved report still rejects when $condition', async ({ condition, error }) => {
  const message = source('1', true, '正文')
  const { input, deps, state } = setup([message], async request =>
    result(JSON.parse(request.prompt).stage === 'reading' ? noObservations : noConclusion))
  await generateInsight(input, deps)
  const checkpoint = state.checkpoint!
  const abort = new AbortController()
  deps.signal = abort.signal
  if (condition === 'checkpoint identity changed') checkpoint.taskId = '8'
  if (condition === 'covered sources do not match the reading cursor') checkpoint.coveredMessageIds = []
  if (condition === 'a frozen source revision changed') deps.read = async () => [{ ...message, revision: 'rev-changed' }]
  if (condition === 'the retry is cancelled during source validation') deps.read = async () => {
    abort.abort()
    return [message]
  }
  await expect(generateInsight({ ...input, checkpoint, elapsedMs: 1_800_000 }, deps)).rejects.toMatchObject(error)
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
