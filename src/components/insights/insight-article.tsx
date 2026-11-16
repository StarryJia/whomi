import { Fragment } from 'react'
import type { InsightReport } from '../../shared/conversation-insights'

export function InsightArticle({ report, onOpenCitation }: {
  report: InsightReport
  onOpenCitation?: (citationId: string, trigger: HTMLButtonElement) => void
}) {
  const citations = new Set(report.citations.filter(citation => citation.fragments.length).map(citation => citation.id))
  function paragraphs(values: InsightReport['aboutYou']) {
    return values.map((paragraph, index) => <p key={index}>
      {paragraph.content.map(({ text, citationId }, part) => citationId && citations.has(citationId) && onOpenCitation
        ? <button key={part} className="insight-citation" type="button" aria-haspopup="dialog"
          onClick={event => onOpenCitation(citationId, event.currentTarget)}>{text}</button>
        : <Fragment key={part}>{text}</Fragment>)}
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
