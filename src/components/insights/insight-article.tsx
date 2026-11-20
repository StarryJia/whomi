import { Fragment } from 'react'
import type { InsightCitation, InsightReport } from '../../shared/conversation-insights'

export function InsightArticle({ report, conversationId, onOpenCitation }: {
  report: InsightReport
  conversationId?: string
  onOpenCitation?: (citation: InsightCitation | undefined, trigger: HTMLButtonElement) => void
}) {
  const citations = new Map(report.citations
    .filter(item => item.conversationId === conversationId && item.fragments.length)
    .map(item => [item.id, item]))
  function paragraphs(values: InsightReport['aboutYou']) {
    return values.map((paragraph, index) => <p key={index}>
      {paragraph.content.map(({ text, citationId }, part) => {
        if (!citationId || !onOpenCitation) return <Fragment key={part}>{text}</Fragment>
        const citation = citations.get(citationId)
        return <button key={part} className="insight-citation" type="button" aria-haspopup={citation && 'dialog'}
          onClick={event => onOpenCitation(citation, event.currentTarget)}>{text}</button>
      })}
    </p>)
  }
  return <article className="insight-prose">
    <section><h2>关于你</h2>{paragraphs(report.aboutYou)}</section>
    <section><h2>你们的相处</h2>{paragraphs(report.relationship)}</section>
    {!!report.limitations.length && <aside className="insight-limitations" aria-label="分析依据限制">
      {report.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
    </aside>}
    <footer>阅读完毕</footer>
  </article>
}
