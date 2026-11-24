import { Fragment } from 'react'
import { dimensionKeys, judgmentCitation, type InsightCitation, type InsightReport } from '../../shared/conversation-insights'
import { personalityDimensions } from '../personality-dimensions'

type ArticleProps = {
  report: InsightReport
  conversationId?: string
  onOpenCitation?: (citation: InsightCitation | undefined, trigger: HTMLButtonElement) => void
}

function PersonalityAnalysis({ report, conversationId, onOpenCitation }: ArticleProps) {
  const judgments = report.judgments
  if (!judgments?.length) return null
  const rows = dimensionKeys.map(axis => ({
    axis, dimension: personalityDimensions[axis],
    entries: judgments.flatMap((item, index) => item.dimension === axis ? [{ item, index }] : []),
  }))
  const prediction = rows.map(({ entries }) => {
    const direction = entries[0]?.item.direction
    return direction && entries.every(({ item }) => item.direction === direction) ? direction : '?'
  }).join('')

  function evidence(index: number, kind: 'supporting' | 'counterexample', dimensionName: string) {
    if (!conversationId || !onOpenCitation) return null
    const citation = judgmentCitation(report, conversationId, index, kind)
    if (!citation) return null
    const label = kind === 'supporting' ? '依据原文' : '反例原文'
    return <button type="button" className="insight-citation" aria-haspopup="dialog" aria-label={dimensionName + '的' + label}
      onClick={event => onOpenCitation(citation, event.currentTarget)}>{label}</button>
  }

  return <section className="insight-personality" aria-label="MBTI 人格倾向">
    <div className="insight-personality-title"><h3><abbr title="迈尔斯－布里格斯性格类型指标">MBTI</abbr> 人格倾向</h3>
      {prediction !== '????' && <strong aria-label={'本次会话的倾向 ' + prediction}>{prediction}</strong>}
    </div>
    {rows.filter(row => row.entries.length).map(({ axis, dimension, entries }) => <div className="insight-dimension" key={axis}>
      <h4>{dimension.name}</h4>
      {entries.map(({ item, index }) => <div className="insight-observation" key={index}>
        <p><strong>{item.direction === null ? '暂难判断' : '偏向' + (item.direction === axis[0] ? dimension.left : dimension.right)}</strong>
          {' · '}{item.text}</p>
        {!!item.alternativeExplanations.length && <div className="insight-observation-notes"><b>其他解释</b>{item.alternativeExplanations.map((text, i) => <p key={i}>{text}</p>)}</div>}
        {!!item.limitations.length && <div className="insight-observation-notes"><b>适用范围</b>{item.limitations.map((text, i) => <p key={i}>{text}</p>)}</div>}
        <div className="insight-observation-sources">
          {evidence(index, 'supporting', dimension.name)}
          {evidence(index, 'counterexample', dimension.name)}
        </div>
      </div>)}
    </div>)}
  </section>
}

export function InsightArticle({ report, conversationId, onOpenCitation }: ArticleProps) {
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
    <section><h2>关于你</h2>{paragraphs(report.aboutYou)}
      <PersonalityAnalysis report={report} conversationId={conversationId} onOpenCitation={onOpenCitation} />
    </section>
    <section><h2>你们的相处</h2>{paragraphs(report.relationship)}</section>
    {!!report.limitations.length && <aside className="insight-limitations" aria-label="分析依据限制">
      {report.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
    </aside>}
    <footer>阅读完毕</footer>
  </article>
}
