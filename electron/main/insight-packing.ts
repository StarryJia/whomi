import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSourceMessage } from '../../src/shared/conversation-insights'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { resolveModelLimits } from '../../src/shared/model-limits'
import type { RuntimeInput } from './ai-service'

export type InsightCursor = { messageIndex: number; textOffset: number }
export type InsightSourcePart = InsightSourceMessage & { fragment?: { start: number; end: number } }
export type InsightSourceBatch = { messages: InsightSourcePart[]; nextCursor: InsightCursor; completedMessageIds: string[] }
export type InsightInputCount = { tokens: number; method: 'provider' | 'tokenizer' | 'estimate' }
type CountInput = (input: RuntimeInput, model: AiModel) => Promise<number | undefined>

const provisionalContextWindow = 16_000
const requestMargin = 256

export function computeInsightInputBudget(input: {
  contextWindow: number; maxInputTokens?: number; reservedOutput: number; occupiedInput: number; margin: number
}): number {
  const inputLimit = Math.min(input.contextWindow - input.reservedOutput, input.maxInputTokens ?? Infinity)
  return Math.max(0, inputLimit - input.occupiedInput - input.margin)
}

export function resolveInsightCapacity(model: AiModel) {
  // 分阶段旧任务的断点按原输出预留计算了成稿额度。
  const maxTokens = model.maxTokens ?? Math.min(8192, (model.contextWindow ?? provisionalContextWindow) - 1)
  const defaults = resolveModelLimits({ ...model, maxTokens })
  return {
    known: model.contextWindow != null,
    contextWindow: model.contextWindow ?? provisionalContextWindow,
    maxInputTokens: model.maxInputTokens ?? undefined,
    maxOutputTokens: defaults.maxTokens,
    margin: requestMargin,
  }
}

export async function countInsightInput(
  input: RuntimeInput, model: AiModel, counters: { provider?: CountInput; tokenizer?: CountInput } = {},
): Promise<InsightInputCount> {
  for (const method of ['provider', 'tokenizer'] as const) {
    const tokens = await counters[method]?.(input, model)
    if (tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0) return { tokens, method }
  }
  const messages = [
    { role: 'system', text: input.systemPrompt },
    ...input.history ?? [],
    { role: 'user', text: input.prompt },
  ]
  return { tokens: Buffer.byteLength(JSON.stringify({ messages }), 'utf8'), method: 'estimate' }
}

export function insightCapacityError(upstream = false): BoundaryError {
  return new BoundaryError(upstream ? 'MODEL_CONTEXT_LIMIT' : 'CONTEXT_TOO_LARGE', '请使用输入容量更大的模型重新生成洞察。')
}

function endOfCharacter(text: string, index: number): number {
  const value = text.codePointAt(index)
  return index + (value !== undefined && value > 0xffff ? 2 : 1)
}

function safeBoundary(text: string, offset: number): number {
  return offset > 0 && offset < text.length && /[\ud800-\udbff]/.test(text[offset - 1]) && /[\udc00-\udfff]/.test(text[offset])
    ? offset - 1 : offset
}

function partOfMessage(message: InsightSourceMessage, start: number, end: number): InsightSourcePart {
  if (start === 0 && end === message.text.length) return message
  return { ...message, text: message.text.slice(start, end), fragment: { start, end } }
}

export function restoreInsightSources(
  messages: readonly InsightSourceMessage[], cursor: InsightCursor, nextCursor: InsightCursor,
): InsightSourceBatch {
  const parts = messages.slice(cursor.messageIndex, nextCursor.messageIndex).map((message, index) =>
    partOfMessage(message, index === 0 ? cursor.textOffset : 0, message.text.length))
  const completedMessageIds = parts.map(part => part.id)
  if (nextCursor.textOffset > 0) {
    parts.push(partOfMessage(
      messages[nextCursor.messageIndex],
      nextCursor.messageIndex === cursor.messageIndex ? cursor.textOffset : 0,
      nextCursor.textOffset,
    ))
  }
  return { messages: parts, nextCursor, completedMessageIds }
}

export async function packInsightSources(input: {
  messages: readonly InsightSourceMessage[]
  cursor: InsightCursor
  availableTokens: number
  count: (text: string) => Promise<number>
}): Promise<InsightSourceBatch> {
  const { messages, cursor, availableTokens, count } = input
  const fit = async (parts: InsightSourcePart[]) => await count(JSON.stringify(parts)) <= availableTokens
  const first = messages[cursor.messageIndex]
  if (!first) return { messages: [], nextCursor: cursor, completedMessageIds: [] }
  const whole = partOfMessage(first, cursor.textOffset, first.text.length)
  if (!await fit([whole])) {
    let low = cursor.textOffset, high = first.text.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (await fit([partOfMessage(first, cursor.textOffset, safeBoundary(first.text, mid))])) low = mid
      else high = mid - 1
    }
    const end = safeBoundary(first.text, low)
    if (end <= cursor.textOffset) throw insightCapacityError()
    return restoreInsightSources(messages, cursor, { messageIndex: cursor.messageIndex, textOffset: end })
  }

  // Doubling probes avoid serializing a growing prefix for every short message.
  const available = messages.length - cursor.messageIndex
  const fitsPrefix = (length: number) => fit([whole, ...messages.slice(cursor.messageIndex + 1, cursor.messageIndex + length)])
  let size = 1
  let probe = Math.min(size * 2, available)
  while (probe > size && await fitsPrefix(probe)) {
    size = probe
    probe = Math.min(probe * 2, available)
  }
  let high = Math.max(size, probe - 1)
  while (size < high) {
    const mid = Math.ceil((size + high) / 2)
    if (await fitsPrefix(mid)) size = mid
    else high = mid - 1
  }
  return restoreInsightSources(messages, cursor, { messageIndex: cursor.messageIndex + size, textOffset: 0 })
}

export function shrinkInsightSources(
  messages: readonly InsightSourceMessage[], cursor: InsightCursor, end: InsightCursor,
): InsightCursor | null {
  const wholeCount = end.messageIndex - cursor.messageIndex
  if (wholeCount > 1 || wholeCount === 1 && end.textOffset > 0) {
    return { messageIndex: cursor.messageIndex + Math.max(1, Math.floor(wholeCount / 2)), textOffset: 0 }
  }
  const text = messages[cursor.messageIndex].text
  const stop = wholeCount === 1 ? text.length : end.textOffset
  const minimum = endOfCharacter(text, cursor.textOffset)
  if (minimum >= stop) return null
  const midpoint = safeBoundary(text, Math.floor((cursor.textOffset + stop) / 2))
  return { messageIndex: cursor.messageIndex, textOffset: Math.max(minimum, midpoint) }
}
