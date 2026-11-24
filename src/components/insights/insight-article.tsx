import { Fragment } from 'react'
import { dimensionKeys, judgmentCitation, type InsightCitation, type InsightJudgment, type InsightReport } from '../../shared/conversation-insights'
import { personalityDimensions } from '../personality-dimensions'

type ArticleProps = {
  report: InsightReport
  conversationId?: string
  allowSourceExcerpts?: boolean
  citationsLoading?: boolean
  onOpenCitation?: (citation: InsightCitation | undefined, trigger: HTMLButtonElement, fragmentIndex?: number, quote?: string, quoteMessageId?: string) => void
}

function directionLabel(axis: InsightJudgment['dimension'], direction: InsightJudgment['direction']) {
  if (!direction) return '暂难判断'
  const dimension = personalityDimensions[axis]
  const label = direction === axis[0] ? dimension.left : dimension.right
  return '偏向' + label.split(' ')[0]
}

function dimensionRows(judgments: InsightJudgment[]) {
  return dimensionKeys.map(axis => {
    const entries = judgments.flatMap((item, index) => item.dimension === axis ? [{ item, index }] : [])
    const first = entries[0]?.item.direction
    const direction = first && entries.every(({ item }) => item.direction === first) ? first : null
    return { axis, name: personalityDimensions[axis].name, direction, entries }
  })
}

function Prediction({ rows }: { rows: ReturnType<typeof dimensionRows> }) {
  const known = rows.filter(row => row.direction)
  const unknown = rows.filter(row => !row.direction).map(row => row.name)
  const last = unknown.pop()
  const unknownNames = unknown.length ? unknown.join('、') + '和' + last : last
  return <section className="insight-prediction" aria-label="MBTI 人格倾向">
    <p className="insight-prediction-label">本次 <abbr title="迈尔斯–布里格斯性格类型指标">MBTI</abbr> 预测</p>
    <strong className="insight-prediction-letters" aria-label={'本次会话的倾向 ' + rows.map(row => row.direction ?? '?').join('')}>
      {rows.map(({ axis, direction }) => <span key={axis} className={direction ? undefined : 'insight-prediction-unknown'}>{direction ?? '?'}</span>)}
    </strong>
    {!!known.length && <p className="insight-prediction-meaning">{known.map(row => directionLabel(row.axis, row.direction)).join(' · ')}</p>}
    {unknownNames && <p className="insight-prediction-limit">{unknownNames}，暂难判断。</p>}
  </section>
}

type Evidence = { kind: 'supporting' | 'counterexample'; text?: string; citation: InsightCitation; fragmentIndex: number; key: string }
type Quote = Evidence & { text: string }

const quotationMarks = [['「', '」'], ['“', '”'], ['『', '』'], ['‘', '’'], ['"', '"']]

function placeQuote(passages: (string | Quote)[][], quote: Quote, delimited: boolean) {
  for (const passage of passages) {
    for (const [i, part] of passage.entries()) {
      if (typeof part !== 'string') continue
      let at = part.indexOf(quote.text)
      while (at >= 0) {
        const end = at + quote.text.length
        if (!delimited || quotationMarks.some(([open, close]) => part[at - 1] === open && part[end] === close)) {
          passage.splice(i, 1, part.slice(0, at), quote, part.slice(end))
          return true
        }
        at = part.indexOf(quote.text, at + 1)
      }
    }
  }
  return false
}

function Observation({ report, item, index, conversationId, allowSourceExcerpts, onOpenCitation, showDirection }: ArticleProps & {
  item: InsightJudgment; index: number; showDirection: boolean
}) {
  const remaining = new Set<Evidence>()
  const occurrences = new Map<string, number>()
  if (conversationId && allowSourceExcerpts) {
    for (const kind of ['supporting', 'counterexample'] as const) {
      const citation = judgmentCitation(report, conversationId, index, kind)
      if (!citation) continue
      const sources = kind === 'supporting' ? item.supportingSources : item.counterexampleSources
      sources.forEach(({ excerpts }, fragmentIndex) => {
        if (!excerpts) return
        const ref = { kind, citation, fragmentIndex, key: citation.id + ':' + fragmentIndex }
        if (!excerpts.length) remaining.add(ref)
        for (const [index, text] of excerpts.entries()) {
          remaining.add({ ...ref, text, key: ref.key + ':' + index })
          occurrences.set(text, (occurrences.get(text) ?? 0) + 1)
        }
      })
    }
  }
  function sourceLink(source: Evidence) {
    let label = source.text
    if (!label) {
      label = source.citation.fragments.length > 1 ? '第 ' + (source.fragmentIndex + 1) + ' 条引用消息'
        : source.kind === 'supporting' ? '这条消息' : '另一条消息'
    }
    return onOpenCitation
      ? <button type="button" key={source.key} className="insight-citation" aria-haspopup="dialog"
        data-source-message={source.citation.fragments[source.fragmentIndex].sources[0].messageId} onClick={event =>
        source.text ? onOpenCitation(source.citation, event.currentTarget, source.fragmentIndex, source.text)
          : onOpenCitation(source.citation, event.currentTarget, source.fragmentIndex)}>{label}</button>
      : label
  }
  // 不同消息可能出现完全相同的原话。无法从分析文字区分时，按各自的来源列出。
  const passages: (string | Quote)[][] = [item.text, ...item.alternativeExplanations, ...item.limitations].map(text => [text])
  const distinct = [...remaining].filter((ref): ref is Quote => !!ref.text && occurrences.get(ref.text) === 1)
    .sort((a, b) => b.text.length - a.text.length)
  for (const delimited of [true, false]) {
    for (const quote of distinct) {
      if (remaining.has(quote) && placeQuote(passages, quote, delimited)) remaining.delete(quote)
    }
  }
  const [body, ...qualifications] = passages.map(parts => parts.map(part => typeof part === 'string' ? part : sourceLink(part)))
  function additionalSources(kind: Evidence['kind']) {
    const sources = [...remaining].filter(source => source.kind === kind && (source.text || onOpenCitation))
    if (!sources.length) return null
    return <>{kind === 'supporting' ? ' 这项观察可以对照' : ' 不同的线索见'}
      {sources.map((source, i) => <Fragment key={source.key}>{i > 0 && '、'}{source.text ? <>「{sourceLink(source)}」</> : sourceLink(source)}</Fragment>)}。</>
  }
  return <div className="insight-observation">
    <p>{showDirection && <strong>{directionLabel(item.dimension, item.direction)}。 </strong>}
      {body}{additionalSources('supporting')}{additionalSources('counterexample')}</p>
    {!!qualifications.length && <p className="insight-observation-context">{qualifications.map((parts, i) =>
      <Fragment key={i}>{i > 0 && ' '}{parts}</Fragment>)}</p>}
  </div>
}

export function InsightArticle({ report, conversationId, allowSourceExcerpts = true, citationsLoading, onOpenCitation }: ArticleProps) {
  const rows = dimensionRows(report.judgments ?? [])
  const citations = new Map(report.citations
    .filter(item => item.conversationId === conversationId && item.fragments.length)
    .map(item => [item.id, item]))
  function paragraphs(values: InsightReport['aboutYou']) {
    return values.map((paragraph, index) => <p key={index}>
      {paragraph.content.map(({ text, citationId, quoteFragmentIndex, quoteMessageId }, part) => {
        if (!citationId || !onOpenCitation) return <Fragment key={part}>{text}</Fragment>
        const citation = citations.get(citationId)
        return <button key={part} disabled={citationsLoading} className="insight-citation" type="button" aria-haspopup={citation && 'dialog'}
          onClick={event => {
            if (allowSourceExcerpts && citation && quoteFragmentIndex !== undefined && Number.isInteger(quoteFragmentIndex) && citation.fragments[quoteFragmentIndex]) {
              onOpenCitation(citation, event.currentTarget, quoteFragmentIndex, text, quoteMessageId)
            } else onOpenCitation(citation, event.currentTarget)
          }}>{text}</button>
      })}
    </p>)
  }
  return <article className="insight-prose">
    {!!report.judgments?.length && <Prediction rows={rows} />}
    <section className="insight-chapter"><h2>关于你</h2>
      {rows.filter(row => row.entries.length).map(({ axis, name, direction, entries }) => <div className="insight-dimension" key={axis}>
        <h3>{name}{' '}<span>· {directionLabel(axis, direction)}</span></h3>
        {entries.map(({ item, index }) => <Observation key={index} report={report} item={item} index={index}
          showDirection={item.direction !== direction} conversationId={conversationId} allowSourceExcerpts={allowSourceExcerpts} onOpenCitation={onOpenCitation} />)}
      </div>)}
      {paragraphs(report.aboutYou)}
    </section>
    <section className="insight-chapter"><h2>你们的相处</h2>{paragraphs(report.relationship)}</section>
    {!!report.limitations.length && <aside className="insight-limitations" aria-label="分析依据限制">
      {report.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
    </aside>}
  </article>
}
