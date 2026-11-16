import { expect, test } from 'vitest'
import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { createInsightCheckpoint, type InsightCheck, type InsightCheckpoint, type InsightEvidenceNote } from '../../electron/main/insight-checkpoint'
import { generateInsight, type InsightGenerationDeps } from '../../electron/main/insight-generation'
import baseline from './fixtures/insight-visible-excerpt-reuse.json'

const model: AiModel = { id: 'quotes', label: 'Quotes', model: 'fixture', baseUrl: 'http://localhost', contextWindow: 12000,
  maxInputTokens: 3200, maxTokens: 600, enabled: true, version: 1, hasCredential: false }
const limits = { maxChecks: 2, maxRoundsPerCheck: 4, maxCalls: 8, maxInputTokens: 50000, maxOutputTokens: 8000, maxElapsedMs: 60000 }
const firstQuote = '甲段已经核实'
const secondQuote = '乙段仍需确认。'
const note = (quote: string, sourceId = '1'): InsightEvidenceNote => ({ sourceId, quote, text: '复用已见摘录。' })
const source = (id: string, text: string): InsightSourceMessage => ({ id, text, revision: 'rev-' + id,
  sentAtMs: 1000 + Number(id), isSelf: id !== '2', senderName: id === '2' ? '对方' : '本人', replyToMessageId: null })
const noObservations = { observations: [], openThreads: [], candidates: [] }
const accepted = new Error('fixture accepted response without continuing the model task')
const result = (payload: unknown) => ({ text: JSON.stringify(payload), checkpoint: '', usage: { inputTokens: 10, outputTokens: 10 } })
const finding = { revisedObservation: '已见说明仍有适用范围。', supportingIds: ['1'], counterexampleIds: [], limitations: [] }
const check = (id: string, evidenceNotes: InsightEvidenceNote[]): InsightCheck => ({ id, observation: '核对这项说明。',
  supportingIds: [evidenceNotes[0].sourceId], state: 'pending', rounds: 0, seenEvidenceIds: [], evidenceNotes,
  navigationRequests: [], pendingNavigation: null, pendingIds: ['3'], pendingCursor: { messageIndex: 0, textOffset: 0 },
  pendingThrough: null, shrinkDepth: 0, repairs: 0, purpose: '核对来源。', finding: null })

function fixture(checking = false) {
  const messages = [source('1', firstQuote + secondQuote + '原文另有未展示说明。'), source('2', '他项独有摘录。'), source('3', '新的进展仍需核对。')]
  const snapshot: InsightSnapshot = { taskId: 'quotes', scope: { kind: 'all' }, timezone: 'Asia/Shanghai', createdAtMs: 0,
    sourceStartTimeMs: 1001, sourceEndTimeMs: 1003, sources: messages.map(({ id, revision }) => ({ messageId: id, revision })) }
  const checkpoint = createInsightCheckpoint('quotes', model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: checking ? 3 : 2, textOffset: 0 }
  checkpoint.coveredMessageIds = checking ? ['1', '2', '3'] : ['1', '2']
  checkpoint.stage = checking ? 'checking' : 'reading'
  checkpoint.checks = [check('1', [note(firstQuote), note(secondQuote)]), check('2', [note('他项独有摘录。', '2')])]
  if (checking) checkpoint.checks = checkpoint.checks.slice(0, 1)
  const state: { checkpoint?: InsightCheckpoint } = {}
  const deps: InsightGenerationDeps = {
    signal: new AbortController().signal, onText() {},
    async read(ids) { return messages.filter(message => ids.includes(message.id)) },
    async saveCheckpoint(value) {
      state.checkpoint = structuredClone(value)
      if (!checking && value.cursor.messageIndex === 3 || checking && value.checks[0].purpose === '已复用摘录。') throw accepted
    },
    async countInput() { return { method: 'tokenizer', tokens: 100 } },
    async run() { throw new Error('Unexpected model request') },
  }
  return { input: { snapshot, conversationId: '1', model, prompts: defaultInsightPrompts, limits, checkpoint }, deps, state, messages }
}

test.each([firstQuote, '已经核实'])('reading reuses a continuous visible excerpt from the same candidate: %s', async quote => {
  const { input, deps, state } = fixture()
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.messages.map((message: InsightSourceMessage) => message.id)).toEqual(['3'])
    expect(payload.relatedMessages).toEqual([])
    expect(payload.knownCandidates.find((candidate: { id: string }) => candidate.id === '1').evidenceNotes).toHaveLength(2)
    return result({ ...noObservations, candidateUpdates: [{ id: '1', action: 'resolve', finding, evidenceNotes: [note(quote)] }] })
  }
  await expect(generateInsight(input, deps)).rejects.toBe(accepted)
  expect(state.checkpoint?.checks[0]).toMatchObject({ state: 'finished', finding })
  expect(state.checkpoint?.checks[0].evidenceNotes).toContainEqual(note(quote))
  expect(state.checkpoint?.callsReserved).toBe(1)
})

test.each([
  { name: 'unseen words in the original', evidence: note('原文另有未展示说明。') },
  { name: 'joined same-source excerpts', evidence: note(firstQuote + secondQuote) },
  { name: 'invented quote', evidence: note('从未提供的文字。') },
  { name: 'wrong source identity', evidence: note(firstQuote, '2') },
  { name: 'an undisplayed candidate', evidence: note('他项独有摘录。', '2'), hiddenCandidate: true },
  { name: 'hidden excerpt of the same candidate', evidence: note(secondQuote), hidden: true },
])('reading rejects reuse from $name', async ({ evidence, hidden, hiddenCandidate }) => {
  const { input, deps, state } = fixture()
  if (hidden || hiddenCandidate) deps.countInput = async request => {
    const payload = JSON.parse(request.prompt)
    return { method: 'tokenizer', tokens: payload.knownCandidates?.some((candidate: { id: string; evidenceNotes: InsightEvidenceNote[] }) =>
      hiddenCandidate ? candidate.id === '2' : candidate.evidenceNotes.some(prior => prior.quote === secondQuote)) ? 3500 : 100 }
  }
  deps.run = async () => result({ ...noObservations, candidateUpdates: [{ id: '1', action: 'resolve', finding, evidenceNotes: [evidence] }] })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint?.callsReserved).toBe(1)
  expect(state.checkpoint?.checks[0].state).toBe('pending')
})

test('a visible old excerpt cannot authorize a new candidate', async () => {
  const { input, deps, state } = fixture()
  deps.run = async () => result({ ...noObservations,
    candidates: [{ observation: '新问题。', supportingIds: ['3'], evidenceNotes: [note(firstQuote)] }] })
  await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint?.callsReserved).toBe(1)
})

test('an update can reuse verified evidence from another currently visible candidate', async () => {
  const { input, deps, state } = fixture()
  const otherNote = note('他项独有摘录。', '2')
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.knownCandidates.find((candidate: { id: string }) => candidate.id === '2').evidenceNotes)
      .toContainEqual(expect.objectContaining(otherNote))
    return result({ ...noObservations, candidateUpdates: [{ id: '1', action: 'resolve',
      finding: { ...finding, supportingIds: ['2'] }, evidenceNotes: [otherNote] }] })
  }
  await expect(generateInsight(input, deps)).rejects.toBe(accepted)
  expect(state.checkpoint?.checks[0]).toMatchObject({ state: 'finished', finding: { supportingIds: ['2'] } })
  expect(state.checkpoint?.checks[0].evidenceNotes).toContainEqual(otherNote)
  expect(state.checkpoint?.callsReserved).toBe(1)
})

test.each([true, false])('checking reuses only one continuous previously verified excerpt (valid: %s)', async valid => {
  const { input, deps, state } = fixture(true)
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.evidence.map((message: InsightSourceMessage) => message.id)).toEqual(['3'])
    expect(payload.evidenceNotes.map((prior: InsightEvidenceNote) => prior.quote)).toEqual([firstQuote, secondQuote])
    return result({ action: 'read', checkId: '1', messageIds: ['1'], purpose: '已复用摘录。',
      evidenceNotes: [note(valid ? '已经核实' : firstQuote + secondQuote)] })
  }
  if (valid) {
    await expect(generateInsight(input, deps)).rejects.toBe(accepted)
    expect(state.checkpoint?.checks[0].evidenceNotes).toContainEqual(note('已经核实'))
  } else await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(state.checkpoint?.callsReserved).toBe(1)
})

test('a previous excerpt cannot stand in for the current unread fragment of the same source', async () => {
  const { input, deps, state, messages } = fixture(true)
  messages[0].text = firstQuote + '后续正文。'.repeat(300)
  input.checkpoint.checks[0].evidenceNotes = [note(firstQuote)]
  input.checkpoint.checks[0].pendingIds = ['1']
  input.checkpoint.checks[0].pendingCursor = { messageIndex: 0, textOffset: firstQuote.length }
  let calls = 0
  deps.countInput = async request => ({ method: 'tokenizer', tokens: 100 + 5 * JSON.stringify(JSON.parse(request.prompt).evidence ?? []).length })
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    calls++
    expect(payload.evidence[0].fragment.start).toBe(firstQuote.length)
    expect(Boolean(payload.repair)).toBe(calls === 2)
    return result({ action: 'read', checkId: '1', messageIds: [], purpose: '已复用摘录。', evidenceNotes: [note(firstQuote),
      ...(calls === 2 ? [note(payload.evidence[0].text.slice(0, 8))] : [])] })
  }
  await expect(generateInsight(input, deps)).rejects.toBe(accepted)
  expect(calls).toBe(2)
  expect(state.checkpoint?.callsReserved).toBe(2)
  expect(state.checkpoint?.checks[0].rounds).toBe(2)
})

test.each([true, false])('baseline response 04 can reuse old quotes while overlapping evidence roles still require repair (overlap: %s)', async overlap => {
  const messages = baseline.messages as InsightSourceMessage[]
  const { input, deps, state } = fixture()
  input.snapshot.sources = messages.map(({ id, revision }) => ({ messageId: id, revision }))
  input.snapshot.sourceStartTimeMs = messages[0].sentAtMs
  input.snapshot.sourceEndTimeMs = messages.at(-1)!.sentAtMs
  const cursor = messages.findIndex(message => message.id === '73')
  input.checkpoint.cursor = { messageIndex: cursor, textOffset: 0 }
  input.checkpoint.coveredMessageIds = messages.slice(0, cursor).map(message => message.id)
  input.checkpoint.openThreads = [{ text: '最初两项条件待核对。', sourceIds: ['1', '2'] }]
  const prior = baseline.knownCandidate
  input.checkpoint.checks = [{ ...check('1', prior.evidenceNotes), observation: prior.observation,
    supportingIds: prior.supportingIds, pendingIds: prior.supportingIds, reason: prior.reason }]
  deps.read = async ids => messages.filter(message => ids.includes(message.id))
  deps.saveCheckpoint = async value => {
    state.checkpoint = structuredClone(value)
    if (value.cursor.messageIndex === messages.length) throw accepted
  }
  const response = structuredClone(baseline.response)
  if (!overlap) response.candidateUpdates[0].finding.supportingIds = response.candidateUpdates[0].finding.supportingIds
    .filter(id => !response.candidateUpdates[0].finding.counterexampleIds.includes(id))
  let calls = 0
  deps.run = async request => {
    const payload = JSON.parse(request.prompt)
    calls++
    expect(payload.relatedMessages.map((message: InsightSourceMessage) => message.id)).toEqual(['1', '2'])
    expect(payload.messages.some((message: InsightSourceMessage) => ['62', '63'].includes(message.id))).toBe(false)
    expect(Boolean(payload.repair)).toBe(calls === 2)
    return result(response)
  }
  if (overlap) {
    await expect(generateInsight(input, deps)).rejects.toMatchObject({ code: 'INVALID_INSIGHT_OUTPUT' })
    expect(calls).toBe(2)
    expect(state.checkpoint?.cursor.messageIndex).toBe(cursor)
    expect(state.checkpoint?.checks[0].state).toBe('pending')
  } else {
    await expect(generateInsight(input, deps)).rejects.toBe(accepted)
    expect(calls).toBe(1)
    expect(state.checkpoint?.checks[0].state).toBe('finished')
  }
})
