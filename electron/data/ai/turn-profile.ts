import type { InsightReport, InsightSourceRef } from '../../../src/shared/conversation-insights'
import type { ProcessingSettings } from '../../../src/shared/settings-contract'
import { createMessageProcessor } from '../../main/message-processing'
import type { Store } from '../db/open'
import { quotedInsightPhrases, readCurrentInsightSources } from './insight-sources'

export function prepareTurnProfile(db: Store['reader'], conversationId: bigint, report: InsightReport, settings?: ProcessingSettings) {
  const judgments = report.judgments ?? []
  const evidence = judgments.flatMap(item => [...item.supportingSources, ...item.counterexampleSources])
  const paragraphs = [...report.aboutYou, ...report.relationship]
  const citations = new Map(report.citations.map(citation => [citation.id, citation.fragments.flatMap(fragment => fragment.sources)]))
  const hidden = new Set<string>()
  if (settings && (settings.redact || settings.clean || settings.denoise)) {
    const ids = new Set([...evidence, ...Array.from(citations.values()).flat()].map(ref => ref.messageId))
    const processor = createMessageProcessor(settings, [])
    const sources = new Map(readCurrentInsightSources(db, conversationId, [...ids]).map(row => {
      const processed = processor.prepare([{ ...row, kind: 'text' }])[0]
      return [row.id, { revision: row.revision, original: row.text, processed: processed?.text ?? '' }]
    }))
    // 单独发送密码值会丢失 password: 这样的识别上下文，须在完整消息中核对引文。
    function check(phrase: string, ref: InsightSourceRef, exact: boolean) {
      const source = sources.get(ref.messageId)
      if (!phrase) return
      if (!source || source.revision !== ref.revision || (exact && !source.original.includes(phrase))) {
        hidden.add(phrase)
      } else if (source.original !== source.processed && source.original.includes(phrase)) {
        if (source.original.split(phrase).length > source.processed.split(phrase).length) hidden.add(phrase)
      }
    }
    for (const ref of evidence) for (const phrase of ref.excerpts ?? []) check(phrase, ref, true)
    for (const item of judgments) {
      const quotes = quotedInsightPhrases([item.text, ...item.alternativeExplanations, ...item.limitations].join('\n'))
      for (const phrase of quotes) for (const ref of [...item.supportingSources, ...item.counterexampleSources]) check(phrase, ref, false)
    }
    for (const paragraph of paragraphs) for (const part of paragraph.content) {
      if (part.citationId) for (const ref of citations.get(part.citationId) ?? []) check(part.text, ref, false)
    }
  }
  for (const ref of evidence) delete ref.excerpts
  const phrases = [...hidden].filter(Boolean).sort((a, b) => b.length - a.length)
  function protect(text: string) {
    for (const phrase of phrases) text = text.replaceAll(phrase, '[已遮盖]')
    return text
  }
  for (const paragraph of paragraphs) for (const part of paragraph.content) {
    delete part.quoteFragmentIndex
    delete part.quoteMessageId
    part.text = protect(part.text)
  }
  for (const item of judgments) {
    item.text = protect(item.text)
    item.alternativeExplanations = item.alternativeExplanations.map(protect)
    item.limitations = item.limitations.map(protect)
  }
  if (report.limitations) report.limitations = report.limitations.map(protect)
}
