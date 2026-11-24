import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import type { InsightCoverage, InsightReadMessage, InsightReadRequest, InsightReadResult, InsightReadSpan } from '../../src/shared/insight-reader'

const errors = {
  out_of_scope: '请使用本次范围内的消息编号。',
  source_changed: '原文已变化，请重新选择范围开始洞察。',
  invalid_request: '请使用返回的续读位置，或指定消息编号与前后条数。',
  insufficient_capacity: '当前可用上下文放不下这页原文，请压缩上下文后重试。',
}
function errorResult(status: keyof typeof errors): InsightReadResult {
  return { page: { status, message: errors[status] }, spans: [] }
}

type Position = { index: number; offset: number; limit: number }
type ReadSources = (ids: readonly string[]) => Promise<InsightSourceMessage[]>

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function safeBoundary(text: string, offset: number) {
  return offset > 0 && offset < text.length && /[\ud800-\udbff]/.test(text[offset - 1]) && /[\udc00-\udfff]/.test(text[offset])
    ? offset - 1 : offset
}

export function addInsightCoverage(previous: InsightCoverage, spans: readonly InsightReadSpan[]): InsightCoverage {
  const covered = new Set(previous.coveredMessageIds)
  const partial = { ...previous.partial }
  for (const { messageId, start, end, length } of spans) {
    if (covered.has(messageId)) continue
    if (![start, end, length].every(nonnegative) || end < start || end > length) throw new Error('无效的原文分片。')
    if (start === 0 && end === length) {
      covered.add(messageId)
      delete partial[messageId]
      continue
    }
    const ranges: [number, number][] = [...partial[messageId] ?? [], [start, end]]
    const merged: [number, number][] = []
    for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1)
      if (last && from <= last[1]) last[1] = Math.max(last[1], to)
      else merged.push([from, to])
    }
    if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === length) {
      covered.add(messageId)
      delete partial[messageId]
    } else partial[messageId] = merged
  }
  return { coveredMessageIds: [...covered], partial }
}

export function insightCursor(taskId: string, index: number, offset: number, limit: number) {
  return index === limit ? null : [taskId, index, offset, limit].join('.')
}

export function createInsightReader(snapshot: InsightSnapshot, readProtectedSources: ReadSources) {
  const positions = new Map(snapshot.sources.map((source, index) => [source.messageId, index]))
  const total = snapshot.sources.length
  function cursor(index: number, offset: number, limit: number) {
    return insightCursor(snapshot.taskId, index, offset, limit)
  }
  function locate(request: InsightReadRequest): Position | keyof typeof errors {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !['cursor', 'messageId', 'before', 'after'].includes(key))) return 'invalid_request'
    if (request.cursor !== undefined) {
      if (Object.keys(request).length !== 1 || typeof request.cursor !== 'string' || request.cursor.length > 100) return 'invalid_request'
      const fields = request.cursor.split('.')
      if (fields.length !== 4 || fields[0] !== snapshot.taskId || fields.slice(1).some(field => !/^\d+$/.test(field))) return 'invalid_request'
      const [index, offset, limit] = fields.slice(1).map(Number)
      return [index, offset, limit].every(nonnegative) && index < limit && limit <= total ? { index, offset, limit } : 'invalid_request'
    }
    if (request.messageId === undefined) return Object.keys(request).length ? 'invalid_request' : { index: 0, offset: 0, limit: total }
    const { before = 0, after = 0 } = request
    if (typeof request.messageId !== 'string' || !nonnegative(before) || !nonnegative(after)) return 'invalid_request'
    const anchor = positions.get(request.messageId)
    return anchor === undefined ? 'out_of_scope' : { index: Math.max(0, anchor - before), offset: 0, limit: Math.min(total, anchor + after + 1) }
  }

  // 附近一条原文失效时，仍须让 Pi 取得它前面可用的一页。
  async function load(index: number, limit: number): Promise<InsightSourceMessage[]> {
    const ids = snapshot.sources.slice(index, limit).map(source => source.messageId)
    try {
      return await readProtectedSources(ids)
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'INVALID_INSIGHT_SOURCE') throw error
      if (ids.length === 1) return []
      return load(index, index + Math.ceil(ids.length / 2))
    }
  }

  return async (request: InsightReadRequest, availableTokens: number): Promise<InsightReadResult> => {
    const position = locate(request)
    if (typeof position === 'string') return errorResult(position)
    if (!Number.isFinite(availableTokens) || availableTokens <= 0) return errorResult('insufficient_capacity')
    const { limit } = position
    let { index, offset } = position
    const messages: InsightReadMessage[] = []
    const spans: InsightReadSpan[] = []
    let contentBytes = 0
    const finish = (): InsightReadResult => ({ page: { status: 'ok', messages, nextCursor: cursor(index, offset, limit) }, spans })
    const fits = (messageBytes: number, next: string | null) => {
      // 与现有容量估算一致，用完整工具回包的 UTF-8 字节数保守计量。
      const envelope = JSON.stringify({ status: 'ok', messages: [], nextCursor: next })
      return Buffer.byteLength(envelope) + contentBytes + Number(messages.length > 0) + messageBytes <= availableTokens
    }
    while (index < limit) {
      const batch = await load(index, Math.min(index + 128, limit))
      if (!batch.length) return messages.length ? finish() : errorResult('source_changed')
      for (const source of batch) {
        const ref = snapshot.sources[index]
        if (ref.messageId !== source.id || ref.revision !== source.revision) return messages.length ? finish() : errorResult('source_changed')
        const length = source.text.length
        if (offset > 0 && (offset >= length || safeBoundary(source.text, offset) !== offset)) return errorResult('invalid_request')
        const messagePart = (end: number): InsightReadMessage => ({
          id: source.id, senderName: source.senderName, isSelf: source.isSelf, sentAtMs: source.sentAtMs,
          replyToMessageId: source.replyToMessageId && positions.has(source.replyToMessageId) ? source.replyToMessageId : null,
          text: source.text.slice(offset, end),
          ...(offset === 0 && end === length ? {} : { fragment: { start: offset, end, length } }),
        })
        let end = length
        let message = messagePart(end)
        const bytes = Buffer.byteLength(JSON.stringify(message))
        if (!fits(bytes, cursor(index + 1, 0, limit))) {
          if (messages.length) return finish()
          // 只拆分单独一页仍放不下的原话，偏移针对脱敏后的正文。
          let low = offset, high = length - 1
          while (low < high) {
            const mid = Math.ceil((low + high) / 2)
            const boundary = safeBoundary(source.text, mid)
            if (fits(Buffer.byteLength(JSON.stringify(messagePart(boundary))), cursor(index, boundary, limit))) low = mid
            else high = mid - 1
          }
          end = safeBoundary(source.text, low)
          if (end <= offset) return errorResult('insufficient_capacity')
          message = messagePart(end)
        }
        spans.push({ messageId: source.id, start: offset, end, length })
        contentBytes += Number(messages.length > 0) + bytes
        messages.push(message)
        if (end < length) { offset = end; return finish() }
        index++
        offset = 0
      }
    }
    return finish()
  }
}
