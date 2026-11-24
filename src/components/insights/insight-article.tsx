import { Fragment } from 'react'
import { dimensionKeys, judgmentCitation, type InsightCitation, type InsightInline, type InsightJudgment, type InsightReport } from '../../shared/conversation-insights'
import { personalityDimensions } from '../personality-dimensions'

type ArticleProps = {
  report: InsightReport
  conversationId?: string
  allowSourceExcerpts?: boolean
  citationsLoading?: boolean
  onOpenCitation?: (citation: InsightCitation | undefined, trigger: HTMLElement, fragmentIndex?: number, quote?: string, quoteMessageId?: string) => void
}

function directionLabel(axis: InsightJudgment['dimension'], direction: InsightJudgment['direction']) {
  if (!direction) return axis[0] + ' / ' + axis[1] + ' · 暂难判断'
  const dimension = personalityDimensions[axis]
  const label = direction === axis[0] ? dimension.left : dimension.right
  return direction + ' · 偏向' + label.split(' ')[0]
}

function dimensionRows(judgments: InsightJudgment[]) {
  return dimensionKeys.map(axis => {
    const entries = judgments.flatMap((item, index) => item.dimension === axis ? [{ item, index }] : [])
    const first = entries[0]?.item.direction
    const direction = first && entries.every(({ item }) => item.direction === first) ? first : null
    return { axis, direction, entries }
  })
}

function Prediction({ rows }: { rows: ReturnType<typeof dimensionRows> }) {
  const known = rows.filter(row => row.direction)
  return <section className="insight-prediction" aria-label="MBTI 人格倾向">
    <p className="insight-prediction-label">本次 <abbr title="迈尔斯–布里格斯性格类型指标">MBTI</abbr> 预测</p>
    <strong className="insight-prediction-letters" aria-label={'本次会话的倾向 ' + rows.map(row => row.direction ?? '?').join('')}>
      {rows.map(({ axis, direction }) => <span key={axis} className={direction ? undefined : 'insight-prediction-unknown'}>{direction ?? '?'}</span>)}
    </strong>
    {!!known.length && <p className="insight-prediction-meaning">{known.map(({ axis, direction }, index) =>
      <Fragment key={axis}>{index > 0 && '、'}<span>{directionLabel(axis, direction)}</span></Fragment>)}</p>}
  </section>
}

type Evidence = { kind: 'supporting' | 'counterexample'; text?: string; citation: InsightCitation; fragmentIndex: number; key: string }
type Quote = Evidence & { text: string; display?: string }

const quotationMarks = [['「', '」'], ['“', '”'], ['『', '』'], ['‘', '’'], ['"', '"']]

function surroundingMarks(before: string, after: string) {
  return quotationMarks.find(([open, close]) => before.endsWith(open) && after.startsWith(close))
}

function inlineParts(content: InsightInline[]) {
  const parts = content.map(part => ({ ...part, display: part.text }))
  for (const [i, part] of parts.entries()) {
    const before = parts[i - 1], after = parts[i + 1]
    if (!part.citationId || !before || before.citationId || !after || after.citationId) continue
    const marks = surroundingMarks(before.display, after.display)
    if (!marks) continue
    before.display = before.display.slice(0, -1)
    after.display = after.display.slice(1)
    part.display = marks[0] + part.text + marks[1]
  }
  return parts
}

function CitationLink({ label, display, disabled, hasDialog, message, open }: {
  label: string; display: string; disabled?: boolean; hasDialog?: boolean; message?: string; open: (trigger: HTMLElement) => void
}) {
  return <span role="button" className="insight-citation" tabIndex={disabled ? -1 : 0}
    aria-label={label} aria-disabled={disabled || undefined} aria-haspopup={hasDialog ? 'dialog' : undefined} data-source-message={message}
    onClick={event => { if (!disabled) open(event.currentTarget) }}
    onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (event.key === 'Enter' && !event.repeat && !disabled) open(event.currentTarget)
    }}
    onKeyUp={event => { if (event.key === ' ') { event.preventDefault(); if (!disabled) open(event.currentTarget) } }}>{display}</span>
}

function placeQuote(passages: (string | Quote)[][], quote: Quote, delimited: boolean) {
  for (const passage of passages) {
    for (const [i, part] of passage.entries()) {
      if (typeof part !== 'string') continue
      let at = part.indexOf(quote.text)
      while (at >= 0) {
        const end = at + quote.text.length
        const marks = surroundingMarks(part.slice(0, at), part.slice(end))
        if (!delimited || marks) {
          const start = marks ? at - 1 : at, stop = marks ? end + 1 : end
          passage.splice(i, 1, part.slice(0, start), { ...quote, display: part.slice(start, stop) }, part.slice(stop))
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
  function sourceLink(source: Evidence, display?: string) {
    let label = source.text
    if (!label) {
      label = source.citation.fragments.length > 1 ? '第 ' + (source.fragmentIndex + 1) + ' 条引用消息'
        : source.kind === 'supporting' ? '这条消息' : '另一条消息'
    }
    return onOpenCitation
      ? <CitationLink key={source.key} hasDialog label={label} display={display ?? label}
        message={source.citation.fragments[source.fragmentIndex].sources[0].messageId} open={trigger =>
        source.text ? onOpenCitation(source.citation, trigger, source.fragmentIndex, source.text)
          : onOpenCitation(source.citation, trigger, source.fragmentIndex)} />
      : display ?? label
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
  const [body, ...qualifications] = passages.map(parts => parts.map(part => typeof part === 'string' ? part : sourceLink(part, part.display)))
  function additionalSources(kind: Evidence['kind']) {
    const sources = [...remaining].filter(source => source.kind === kind && (source.text || onOpenCitation))
    if (!sources.length) return null
    return <>{kind === 'supporting' ? ' 这项观察可以对照' : ' 不同的线索见'}
      {sources.map((source, i) => <Fragment key={source.key}>{i > 0 && '、'}{sourceLink(source, source.text ? '「' + source.text + '」' : undefined)}</Fragment>)}。</>
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
  const observed = rows.filter(row => row.entries.length)
  const citations = new Map(report.citations
    .filter(item => item.conversationId === conversationId && item.fragments.length)
    .map(item => [item.id, item]))
  function paragraphs(values: InsightReport['aboutYou']) {
    return values.map((paragraph, index) => <p key={index}>
      {inlineParts(paragraph.content).map(({ text, display, citationId, quoteFragmentIndex, quoteMessageId }, part) => {
        if (!citationId || !onOpenCitation) return <Fragment key={part}>{display}</Fragment>
        const citation = citations.get(citationId)
        return <CitationLink key={part} disabled={citationsLoading} label={text} display={display} hasDialog={!!citation}
          open={trigger => {
            if (allowSourceExcerpts && citation && quoteFragmentIndex !== undefined && Number.isInteger(quoteFragmentIndex) && citation.fragments[quoteFragmentIndex]) {
              onOpenCitation(citation, trigger, quoteFragmentIndex, text, quoteMessageId)
            } else onOpenCitation(citation, trigger)
          }} />
      })}
    </p>)
  }
  if (!observed.length && !report.aboutYou.length && !report.relationship.length) {
    return <article className="insight-prose"><p>这份报告没有分析正文。</p></article>
  }
  return <article className="insight-prose">
    {!!observed.length && <Prediction rows={rows} />}
    <section className="insight-chapter"><h2>关于你</h2>
      {!!observed.length && <section className="insight-analysis">
        <h3>MBTI 人格倾向</h3>
        {observed.map(({ axis, direction, entries }) => <div className="insight-dimension" key={axis}>
          <h4>{directionLabel(axis, direction)}</h4>
          {entries.map(({ item, index }) => <Observation key={index} report={report} item={item} index={index}
            showDirection={item.direction !== direction} conversationId={conversationId} allowSourceExcerpts={allowSourceExcerpts} onOpenCitation={onOpenCitation} />)}
        </div>)}
      </section>}
      {observed.length > 0 && report.aboutYou.length > 0 ? <section className="insight-personal-observations"><h3>个人观察</h3>
        {paragraphs(report.aboutYou)}</section> : paragraphs(report.aboutYou)}
    </section>
    <section className="insight-chapter"><h2>你们的相处</h2>{paragraphs(report.relationship)}</section>
    {!!report.limitations?.length && <aside className="insight-report-limitations" aria-label="分析依据限制">
      <strong>分析依据限制</strong>
      {report.limitations.map((text, index) => <p key={index}>{text}</p>)}
    </aside>}
  </article>
}
