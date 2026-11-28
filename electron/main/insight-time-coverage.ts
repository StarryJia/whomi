import type { InsightReport, InsightSnapshot } from '../../src/shared/conversation-insights'
import type { InsightEvidenceCard } from '../data/ai/insight-evidence-card'
import type { InsightSegmentPlan } from './insight-segmentation'

export type InsightTimeCoverage = {
  buckets: [number, number, number, number, number]
  segmentCitationCounts: number[]
  totalCitations: number
  uncoveredEarlierSegments: number[]
  needsCorrection: boolean
  correctionPrompt: string
}

export function analyzeInsightTimeCoverage(
  snapshot: InsightSnapshot, report: InsightReport, segments: readonly InsightSegmentPlan[] = [],
  evidenceCards: readonly InsightEvidenceCard[] = [],
): InsightTimeCoverage {
  const cited = new Set(report.citations.flatMap(c => c.fragments.flatMap(f => f.sources.map(s => s.messageId))))
  for (const judgment of report.judgments ?? []) {
    for (const ref of [...judgment.supportingSources, ...judgment.counterexampleSources]) cited.add(ref.messageId)
  }
  const buckets: InsightTimeCoverage['buckets'] = [0, 0, 0, 0, 0]
  const segmentCitationCounts = segments.map(() => 0)
  const total = snapshot.sources.length
  let segment = 0, totalCitations = 0
  snapshot.sources.forEach(({ messageId }, index) => {
    if (!cited.has(messageId)) return
    totalCitations++
    buckets[Math.floor(index * 5 / total)]++
    while (segment < segments.length && segments[segment].endIndex < index) segment++
    if (segment < segments.length && segments[segment].startIndex <= index) segmentCitationCounts[segment]++
  })
  const uncoveredEarlierSegments = segments.slice(0, -1).flatMap(({ index }) => {
    const card = evidenceCards[index]
    return !segmentCitationCounts[index] && card && (card.events.length || card.selfSignals.length || card.riskSignals.length) ? [index] : []
  })
  const earlyHalf = Math.floor(segments.length / 2)
  const needsCorrection = totalCitations > 0 && (segments.length >= 2
    ? uncoveredEarlierSegments.some(i => i < earlyHalf) && segmentCitationCounts.slice(0, earlyHalf).every(n => n === 0)
    : total >= 50 && buckets.slice(0, 3).every(n => n === 0))
  let correctionPrompt = ''
  if (needsCorrection) {
    const periods = segments.length >= 2
      ? uncoveredEarlierSegments.map(i => {
        const card = evidenceCards[i], plan = segments[i]
        return `第 ${i + 1} 段（${card.period}，消息 ${plan.startMessageId} 至 ${plan.endMessageId}）` +
          card.events.map(event => event.summary).join('；')
      }).join('\n')
      : `前 60% 的消息（${snapshot.sources[0].messageId} 至 ${snapshot.sources[Math.ceil(total * 0.6) - 1].messageId}）`
    correctionPrompt = `请核查以下尚无引用的早期时段：\n${periods}\n按需用 read_messages({ messageId, before, after }) 核对原话与上下文。将有依据的跨期观察纳入完整报告并引用对应消息，保留真实反例与变化。证据有限时如实说明。只提交完整报告 JSON。`
  }
  return { buckets, segmentCitationCounts, totalCitations, uncoveredEarlierSegments, needsCorrection, correctionPrompt }
}
