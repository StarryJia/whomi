import type { InsightSnapshot, InsightSourceMessage } from '../../src/shared/conversation-insights'
import type { InsightCoverage, InsightReadMessage, InsightReadPage, InsightReadRequest, InsightReadResult, InsightReadSpan } from '../../src/shared/insight-reader'
import { estimateTranscriptTokens, formatInsightReadPage, formatInsightTranscript } from './insight-transcript'

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

function largestFit(low: number, high: number, fits: (size: number) => boolean) {
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(mid)) low = mid
    else high = mid - 1
  }
  return low
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
    const messages: InsightReadMessage[] = []
    let index = position.index
    let minimumTokens = 0
    collect: while (index < limit) {
      const batch = await load(index, Math.min(index + 128, limit))
      if (!batch.length) break
      for (const source of batch) {
        const ref = snapshot.sources[index]
        if (ref.messageId !== source.id || ref.revision !== source.revision) break collect
        const offset = index === position.index ? position.offset : 0
        const length = source.text.length
        if (offset > 0 && (offset >= length || safeBoundary(source.text, offset) !== offset)) return errorResult('invalid_request')
        const text = source.text.slice(offset)
        messages.push({
          id: source.id, senderName: source.senderName, isSelf: source.isSelf, sentAtMs: source.sentAtMs,
          replyToMessageId: source.replyToMessageId !== null && positions.has(source.replyToMessageId) ? source.replyToMessageId : null,
          text, ...(offset ? { fragment: { start: offset, end: length, length } } : {}),
        })
        index++
        // 编号和原话已超过容量时，无须再加载后续原文来确定分页位置。
        minimumTokens += estimateTranscriptTokens(source.id + ' ' + text)
        if (minimumTokens > availableTokens) break collect
      }
    }
    if (!messages.length && index < limit) return errorResult('source_changed')

    function page(parts: InsightReadMessage[], nextCursor: string | null): InsightReadPage {
      return { status: 'ok', transcript: formatInsightTranscript(parts, snapshot.timezone), nextCursor }
    }
    const fits = (candidate: InsightReadPage) => estimateTranscriptTokens(formatInsightReadPage(candidate)) <= availableTokens
    const prefix = (count: number) => page(messages.slice(0, count), cursor(position.index + count, 0, limit))
    const finish = (page: InsightReadPage, parts: InsightReadMessage[]): InsightReadResult => ({
      page, spans: parts.map(({ id, text, fragment }) => ({
        messageId: id, ...(fragment ?? { start: 0, end: text.length, length: text.length }),
      })),
    })
    const full = prefix(messages.length)
    if (fits(full)) return finish(full, messages)
    if (!messages.length) return errorResult('insufficient_capacity')

    // 群聊中 ta 可能变成更短的 A，分别在更换标记前后查找最大页。
    const firstPeer = messages.find(message => !message.isSelf)?.senderName
    const groupStart = messages.findIndex(message => !message.isSelf && message.senderName !== firstPeer) + 1
    let low = 0
    let high = messages.length - 1
    if (groupStart && groupStart <= high) {
      if (fits(prefix(groupStart))) low = groupStart
      else high = groupStart - 1
    }
    const count = largestFit(low, high, size => fits(prefix(size)))
    if (count) return finish(prefix(count), messages.slice(0, count))

    const first = messages[0]
    const start = position.offset
    const length = start + first.text.length
    const fragment = (size: number) => ({
      ...first, text: first.text.slice(0, size), fragment: { start, end: start + size, length },
    })
    const fragmentPage = (size: number) => page([fragment(size)], cursor(position.index, start + size, limit))
    const end = largestFit(0, first.text.length - 1, size => fits(fragmentPage(safeBoundary(first.text, size))))
    const size = safeBoundary(first.text, end)
    return size ? finish(fragmentPage(size), [fragment(size)]) : errorResult('insufficient_capacity')
  }
}
