import type { InsightSourceMessage } from '../../src/shared/conversation-insights'
import { estimateTranscriptTokens, formatInsightTranscript } from './insight-transcript'

const segmentTokenCap = 24_000
const sixHours = 6 * 60 * 60 * 1000

export type InsightSegmentPlan = {
  index: number
  startIndex: number
  endIndex: number
  startMessageId: string
  endMessageId: string
  startTimeMs: number | null
  endTimeMs: number | null
  messageCount: number
  estimatedTokens: number
}

export function insightSegmentTokenBudget(maxInputTokens: number, instructionTokens: number) {
  const priorCardReserve = Math.ceil(maxInputTokens / 4)
  return Math.max(1, Math.min(segmentTokenCap, Math.floor(maxInputTokens - instructionTokens - priorCardReserve)))
}

function firstTrue(low: number, high: number, test: (n: number) => boolean) {
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (test(mid)) high = mid
    else low = mid + 1
  }
  return low
}

export function planInsightSegments(
  messages: readonly InsightSourceMessage[], timezone: string, segmentTokenBudget: number,
): InsightSegmentPlan[] {
  if (!Number.isFinite(segmentTokenBudget) || segmentTokenBudget < 1) throw new RangeError('分段词元预算必须为正数。')
  const budget = Math.min(segmentTokenCap, Math.floor(segmentTokenBudget))
  let date: Intl.DateTimeFormat
  try {
    date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    date = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' })
  }
  const dates = messages.map(({ sentAtMs }) => sentAtMs !== null && Number.isFinite(new Date(sentAtMs).getTime()) ? date.format(sentAtMs) : null)
  // 原话与编号不会随发言人图例缩短，用它们的词元下界限制精确排版的搜索范围。
  const minimum = [0]
  for (const { id, text } of messages) minimum.push(minimum.at(-1)! + estimateTranscriptTokens(id + ' ' + text) - 1)
  const plans: InsightSegmentPlan[] = []
  for (let start = 0; start < messages.length;) {
    const remaining = messages.length - start
    const high = firstTrue(1, remaining + 1, n => minimum[start + n] - minimum[start] > budget) - 1
    const sizes = new Map<number, number>()
    function tokens(n: number) {
      const cached = sizes.get(n)
      if (cached !== undefined) return cached
      const size = estimateTranscriptTokens(formatInsightTranscript(messages.slice(start, start + n), timezone))
      sizes.set(n, size)
      return size
    }
    let count = 1
    if (high === remaining && tokens(remaining) <= budget) count = remaining
    else if (high > 1) {
      const candidates = messages.slice(start, start + high)
      // 第二位对方出现时 ta 可能变成更短的名字。分别计算两种图例下的可选切点。
      const firstPeer = candidates.find(m => !m.isSelf)?.senderName
      const groupStart = candidates.findIndex(m => !m.isSelf && m.senderName !== firstPeer) + 1
      const ranges = groupStart ? [[1, groupStart - 1], [groupStart, high]] : [[1, high]]
      const windows = ranges.map(([from, to]) => {
        const last = firstTrue(from, to + 1, n => tokens(n) > budget) - 1
        count = Math.max(count, last >= from ? last : 1)
        return [firstTrue(from, last + 1, n => tokens(n) >= 0.6 * budget), last]
      })
      // 同等质量的切点优先均分剩余消息，避免把零散尾段单独交给模型。
      const target = remaining / Math.ceil(remaining / count)
      let bestRank = 0, bestGap = 0
      for (const [first, last] of windows) {
        for (let n = first; n <= last; n++) {
          const right = start + n, left = right - 1
          if (!dates[left] || !dates[right]) continue
          const gap = messages[right].sentAtMs! - messages[left].sentAtMs!
          const rank = dates[left] !== dates[right] || gap >= sixHours ? 2 : gap > 0 ? 1 : 0
          if (!rank) continue
          if (rank > bestRank || (rank === bestRank && (gap > bestGap ||
              (gap === bestGap && Math.abs(n - target) < Math.abs(count - target))))) {
            bestRank = rank
            bestGap = gap
            count = n
          }
        }
      }
    }
    const end = start + count - 1
    plans.push({ index: plans.length, startIndex: start, endIndex: end, startMessageId: messages[start].id,
      endMessageId: messages[end].id, startTimeMs: messages[start].sentAtMs, endTimeMs: messages[end].sentAtMs,
      messageCount: count, estimatedTokens: tokens(count) })
    start = end + 1
  }
  return plans
}
