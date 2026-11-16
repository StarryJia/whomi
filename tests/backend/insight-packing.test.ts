import { expect, test } from 'vitest'
import type { AiModel } from '../../src/shared/ai-contract'
import { computeInsightInputBudget, countInsightInput, packInsightSources, resolveInsightCapacity } from '../../electron/main/insight-packing'

const model: AiModel = {
  id: 'fixture', label: 'Fixture', model: 'fixture', baseUrl: 'http://localhost',
  contextWindow: null, maxTokens: null, maxInputTokens: null, enabled: true, version: 1, hasCredential: false,
}
const message = (id: string, sentAtMs: number, text = id, replyToMessageId: string | null = null) => ({
  id, revision: 'r' + id, senderName: '甲', isSelf: true, sentAtMs, text, replyToMessageId,
})
const cursor = { messageIndex: 0, textOffset: 0 }
const count = async (serialized: string) => Buffer.byteLength(serialized)

test('the total context and independent input limit both constrain the available input', () => {
  expect(computeInsightInputBudget({
    contextWindow: 32000, maxInputTokens: 28000, reservedOutput: 4000, occupiedInput: 3000, margin: 1000,
  })).toBe(24000)
  expect(computeInsightInputBudget({
    contextWindow: 32000, maxInputTokens: 9000, reservedOutput: 4000, occupiedInput: 3000, margin: 1000,
  })).toBe(5000)
  expect(computeInsightInputBudget({
    contextWindow: 10, reservedOutput: 8, occupiedInput: 2, margin: 1,
  })).toBe(0)
})

test('unknown limits use a conservative estimate of the complete request without credentials', async () => {
  const capacity = resolveInsightCapacity(model)
  expect(capacity).toMatchObject({ known: false, margin: expect.any(Number) })
  expect(capacity.contextWindow).toBeLessThan(resolveInsightCapacity({ ...model, contextWindow: 128000 }).contextWindow)
  const base = { key: 'test', model, systemPrompt: '规则', prompt: '正文' }
  const minimal = await countInsightInput(base, model)
  expect(minimal.method).toBe('estimate')
  expect(await countInsightInput({ ...base, apiKey: 'secret '.repeat(40) }, model)).toEqual(minimal)
  const withHistory = await countInsightInput({ ...base, history: [{ role: 'assistant', text: '承接记录' }] }, model)
  expect(withHistory.tokens).toBeGreaterThan(minimal.tokens)
  expect(await countInsightInput(base, model, { tokenizer: async () => 27, provider: async () => 30 }))
    .toEqual({ tokens: 30, method: 'provider' })
})

test('capacity splits a dense day while sparse days and overnight replies retain source order', async () => {
  const beforeMidnight = Date.UTC(2026, 9, 9, 15, 58)
  const afterMidnight = Date.UTC(2026, 9, 9, 16, 5)
  const overnight = [message('1', beforeMidnight, '改期？'), message('2', afterMidnight, '改到周一', '1'), message('3', afterMidnight + 86_400_000 * 2)]
  const sparse = await packInsightSources({ messages: overnight, cursor, availableTokens: 800, count })
  expect(sparse.messages).toEqual(overnight)
  const dense = [message('1', beforeMidnight, 'a'.repeat(180)), message('2', beforeMidnight + 1, 'b'.repeat(180))]
  const first = await packInsightSources({ messages: dense, cursor, availableTokens: 420, count })
  expect(first.messages).toEqual([dense[0]])
  expect(first.completedMessageIds).toEqual(['1'])
  expect((await packInsightSources({ messages: dense, cursor: first.nextCursor, availableTokens: 420, count })).messages).toEqual([dense[1]])
})

test('an oversized message retains exact Unicode fragments and is covered only on its last fragment', async () => {
  const messages = [message('9', 3, '😀'.repeat(125))]
  const pieces = []
  const coverage = []
  let at = cursor
  while (at.messageIndex === 0 && pieces.length < 10) {
    const packed = await packInsightSources({ messages, cursor: at, availableTokens: 310, count })
    pieces.push(packed.messages[0])
    coverage.push(packed.completedMessageIds)
    at = packed.nextCursor
  }
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces.every(piece => /^(?:😀)+$/u.test(piece.text))).toBe(true)
  expect(pieces.map(piece => piece.text).join('')).toBe(messages[0].text)
  expect(pieces.map(piece => piece.id)).toEqual(pieces.map(() => '9'))
  expect(coverage.slice(0, -1).every(ids => !ids.length)).toBe(true)
  expect(coverage.at(-1)).toEqual(['9'])
})

test('the source wrapper participates in fitting even an empty message', async () => {
  await expect(packInsightSources({ messages: [message('1', 5, '')], cursor, availableTokens: 2, count }))
    .rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' })
})
