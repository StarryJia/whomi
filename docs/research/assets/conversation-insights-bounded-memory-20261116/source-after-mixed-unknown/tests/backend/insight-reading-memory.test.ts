import { expect, test } from 'vitest'
import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { createInsightCheckpoint, type InsightCheckpoint } from '../../electron/main/insight-checkpoint'
import { generateInsight, type InsightGenerationDeps } from '../../electron/main/insight-generation'

const model: AiModel = {
  id: 'reading-memory-fixture', label: 'Fixture', model: 'fixture', baseUrl: 'http://localhost',
  contextWindow: 12000, maxInputTokens: 3200, maxTokens: 600, enabled: true, version: 1, hasCredential: false,
}
const limits = { maxChecks: 2, maxRoundsPerCheck: 2, maxCalls: 32, maxInputTokens: 100000, maxOutputTokens: 24000, maxElapsedMs: 60000 }
const noObservations = { observations: [], openThreads: [], candidates: [] }
const stoppedAfterReading = new Error('fixture stopped after reading')
const source = (id: string): InsightSourceMessage => ({
  id, revision: 'revision-' + id, text: '事项 ' + id, sentAtMs: 1000 + Number(id),
  senderName: '本人', isSelf: true, replyToMessageId: null,
})

function resumeReading(oldCount: number, newCount: number, run: InsightGenerationDeps['run'], messageCost: number) {
  const messages = Array.from({ length: oldCount + newCount }, (_, index) => source(String(index + 1)))
  const snapshot: InsightSnapshot = {
    taskId: 'reading-memory-task', scope: { kind: 'all' }, timezone: 'Asia/Shanghai', createdAtMs: 1000,
    sourceStartTimeMs: messages[0].sentAtMs, sourceEndTimeMs: messages.at(-1)!.sentAtMs,
    sources: messages.map(message => ({ messageId: message.id, revision: message.revision })),
  }
  const checkpoint = createInsightCheckpoint(snapshot.taskId, model, defaultInsightPrompts, limits)
  checkpoint.cursor = { messageIndex: oldCount, textOffset: 0 }
  checkpoint.coveredMessageIds = messages.slice(0, oldCount).map(message => message.id)
  checkpoint.openThreads = checkpoint.coveredMessageIds.map(id => ({ text: '事项 ' + id + ' 尚未确认。', sourceIds: [id] }))
  const state: { checkpoint: InsightCheckpoint | null } = { checkpoint: null }
  const deps: InsightGenerationDeps = {
    run,
    async read(ids) { return messages.filter(message => ids.includes(message.id)) },
    async saveCheckpoint(value) {
      state.checkpoint = structuredClone(value)
      if (value.coveredMessageIds.length === messages.length) throw stoppedAfterReading
    },
    signal: new AbortController().signal,
    onText: () => {},
    async countInput(request) {
      const payload = JSON.parse(request.prompt)
      return { method: 'tokenizer', tokens: 100 + messageCost * (payload.messages?.length ?? 0)
        + 10000 * (payload.relatedMessages?.length ?? 0)
        + 100 * (payload.openThreads?.length ?? 0)
        + 100 * (payload.observations?.length ?? 0) }
    },
  }
  return { messages, input: { snapshot, conversationId: 'conversation', model, prompts: defaultInsightPrompts, limits, checkpoint }, deps, state }
}

test('a reply can update an older thread even when new messages could otherwise fill the reading budget', async () => {
  let updated = false
  const fixture = resumeReading(20, 2, async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.stage).toBe('reading')
    if (payload.messages.some((message: InsightSourceMessage) => message.id === '21')) {
      updated = payload.openThreads.some((note: { sourceIds: string[] }) => note.sourceIds.includes('1'))
      return { text: JSON.stringify({ ...noObservations, resolvedThreadSourceIds: updated ? ['1'] : [] }), checkpoint: '', usage: { inputTokens: 18, outputTokens: 10 } }
    }
    return { text: JSON.stringify(noObservations), checkpoint: '', usage: { inputTokens: 18, outputTokens: 10 } }
  }, 1400)
  fixture.messages[20].replyToMessageId = '1'
  await expect(generateInsight(fixture.input, fixture.deps)).rejects.toBe(stoppedAfterReading)
  expect(updated).toBe(true)
  expect(fixture.state.checkpoint?.openThreads.some(note => note.sourceIds.includes('1'))).toBe(false)
  expect(fixture.state.checkpoint?.openThreads.some(note => note.sourceIds.includes('20'))).toBe(true)
})

test('unlinked old threads rotate through later reading batches instead of remaining hidden behind recent threads', async () => {
  const visible = new Set<string>()
  const fixture = resumeReading(20, 20, async request => {
    const payload = JSON.parse(request.prompt)
    expect(payload.stage).toBe('reading')
    for (const note of payload.openThreads) for (const id of note.sourceIds) visible.add(id)
    return { text: JSON.stringify(noObservations), checkpoint: '', usage: { inputTokens: 18, outputTokens: 10 } }
  }, 2000)
  await expect(generateInsight(fixture.input, fixture.deps)).rejects.toBe(stoppedAfterReading)
  expect([...visible].sort((left, right) => Number(left) - Number(right))).toEqual([
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  ])
})

test('growing unresolved work cannot starve an older item after resuming partway through reading', async () => {
  const visible = new Set<string>()
  const fixture = resumeReading(20, 8, async request => {
    const payload = JSON.parse(request.prompt)
    for (const note of payload.openThreads) for (const id of note.sourceIds) visible.add(id)
    const currentId = payload.messages[0].id
    return {
      text: JSON.stringify({ ...noObservations, openThreads: Array.from({ length: 7 }, (_, index) => ({
        text: '本批新增待确认事项 ' + currentId + '-' + index, sourceIds: [currentId],
      })) }),
      checkpoint: '', usage: { inputTokens: 18, outputTokens: 10 },
    }
  }, 2000)
  fixture.input.checkpoint.readLayouts = Array.from({ length: 5 }, (_, index) => ({
    from: { messageIndex: index * 4, textOffset: 0 },
    to: { messageIndex: (index + 1) * 4, textOffset: 0 }, depth: 0,
  }))
  await expect(generateInsight(fixture.input, fixture.deps)).rejects.toBe(stoppedAfterReading)
  expect(visible.has('1')).toBe(true)
  expect(fixture.state.checkpoint?.openThreads.some(note => note.sourceIds.includes('1'))).toBe(true)
})

test('adding a new unresolved item preserves more than forty-eight existing task items', async () => {
  const fixture = resumeReading(49, 1, async () => ({
    text: JSON.stringify({ ...noObservations, openThreads: [{ text: '最新事项也未确认。', sourceIds: ['50'] }] }),
    checkpoint: '', usage: { inputTokens: 18, outputTokens: 10 },
  }), 1400)
  await expect(generateInsight(fixture.input, fixture.deps)).rejects.toBe(stoppedAfterReading)
  expect(fixture.state.checkpoint?.openThreads).toHaveLength(50)
  expect(fixture.state.checkpoint?.openThreads).toContainEqual({ text: '事项 1 尚未确认。', sourceIds: ['1'] })
})
