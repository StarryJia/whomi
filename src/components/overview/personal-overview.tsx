import { useEffect, useId, useRef, type RefObject, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ChevronRight, FileInput, MessageSquare, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { OverviewData, PreferenceEstimate, SourceReference, SparkDiscovery, SparkScene } from './types'
import type { useOverviewFeedback } from './use-overview-feedback'
import { dimensionKeys, type MemoryDimensions } from '../../shared/memory'
import { personalityDimensions } from '../personality-dimensions'
import './personal-overview.css'

interface PersonalOverviewProps {
  concealed?: boolean
  status?: 'loading' | 'error' | 'ready'
  retry?: () => void
  data?: OverviewData
  headingRef: RefObject<HTMLHeadingElement | null>
  onReturnToCover: () => void
  children?: ReactNode
  hasRelationshipObservations?: boolean
  conversationTitle?: string
  onOpenConversation?: () => void
  onOpenMemory?: () => void
  onImport: () => void
  onOpenSource: (source: SourceReference) => void
  isSourceAvailable: (source: SourceReference) => boolean
  feedback: ReturnType<typeof useOverviewFeedback>
}

const unknownEstimate: PreferenceEstimate = { status: 'unknown' }
const noDiscoveries: readonly SparkDiscovery[] = []

function PreferenceRow({ axis, estimate }: { axis: keyof MemoryDimensions; estimate: PreferenceEstimate }) {
  const { name, left, right } = personalityDimensions[axis]
  let result = '尚待了解'
  let evidence: ReactNode
  if (estimate.status === 'unknown') {
    evidence = estimate.reason
  } else if (estimate.status === 'split') {
    result = '关系票数持平'
    evidence = estimate.contexts.map(context => <p key={context}>{context}</p>)
  } else {
    const strength = estimate.strength === 'slight' ? '略偏' : '偏向'
    result = estimate.leaning === 'balanced' ? '较均衡' : strength + (estimate.leaning === 'left' ? left : right)
    evidence = estimate.context
  }

  return <div className="overview-preference-row" role="group" aria-label={`${left} / ${right}`}>
    <div className="overview-preference-name"><h3>{name}</h3><p>{left} · {right}</p></div>
    <strong className={`overview-preference-result${estimate.status === 'unknown' ? ' is-unknown' : ''}`}>{result}</strong>
    {evidence && <div className="overview-preference-evidence">{evidence}</div>}
  </div>
}

function contextualScenes(discovery: SparkDiscovery) {
  return discovery.scenes.filter((scene) => scene.context.trim() && scene.interaction.trim() && scene.behavior.trim() &&
    scene.sourceIds.some((id) => discovery.sources.some((source) => source.id === id && source.context.trim() &&
      source.conversationId && source.messageId)))
}

function SourceRow({ source, onOpen, available }: { source: SourceReference; onOpen: (source: SourceReference) => void; available: boolean }) {
  return <button type="button" className="overview-source-row" aria-disabled={!available}
    onClick={() => { if (available) onOpen(source) }}>
    <MessageSquare aria-hidden="true" />
    <strong>{source.title}</strong>
    <span className="overview-source-context">{source.context}</span>
    {!available && <span className="overview-source-unavailable">原文暂不可用</span>}
    <ChevronRight className="overview-source-arrow" aria-hidden="true" />
  </button>
}

function SparkArticle({ discovery, scenes, feedback, onOpenSource, isSourceAvailable }: {
  discovery: SparkDiscovery; scenes: readonly SparkScene[]; feedback: ReturnType<typeof useOverviewFeedback>
  onOpenSource: (source: SourceReference) => void; isSourceAvailable: (source: SourceReference) => boolean
}) {
  const id = useId()
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const entry = feedback.get(discovery.id)
  const sources = discovery.sources.filter((source) => scenes.some((scene) => scene.sourceIds.includes(source.id)))
  const unavailableSource = sources.some((source) => source.unavailable || !isSourceAvailable(source))

  return <article className="overview-spark-article" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{discovery.title}</h3>
    {discovery.selfDescription && <p className="overview-spark-self">你曾提到：{discovery.selfDescription}</p>}
    <div className="overview-spark-scenes">
      {scenes.map((scene, index) => <div key={`${scene.title}-${index}`} className="overview-spark-scene" role="group" aria-label={scene.title}>
        <h4>{scene.title}</h4>
        <dl>
          <div><dt>当时的背景</dt><dd>{scene.context}</dd></div>
          <div><dt>你们的交流</dt><dd>{scene.interaction}</dd></div>
          <div><dt>你的回应</dt><dd>{scene.behavior}</dd></div>
        </dl>
      </div>)}
    </div>
    <p className="overview-spark-observation">{discovery.observation}</p>
    {discovery.qualification && <p className="overview-spark-qualification">{discovery.qualification}</p>}
    <div className="overview-spark-sources" role="group" aria-label="相关原文">
      <h4>相关原文</h4>
      {sources.map((source) => <SourceRow key={source.id} source={source} onOpen={onOpenSource}
        available={!source.unavailable && isSourceAvailable(source)} />)}
      {unavailableSource && <p className="overview-source-notice">原文暂不可用，这条观察仍待核对。</p>}
    </div>
    <form className="overview-feedback" onSubmit={(event) => { event.preventDefault(); void feedback.submit(discovery.id) }}>
      <div className="overview-feedback-actions" role="group" aria-label="对这条发现的看法">
        <button type="button" aria-pressed={entry.draft.vote === 'agree'} onClick={() => feedback.toggleVote(discovery.id, 'agree')}>
          <ThumbsUp aria-hidden="true" />赞同
        </button>
        <button type="button" aria-pressed={entry.draft.vote === 'disagree'} onClick={() => feedback.toggleVote(discovery.id, 'disagree')}>
          <ThumbsDown aria-hidden="true" />不赞同
        </button>
        <button type="button" onClick={() => commentRef.current?.focus()}><MessageSquare aria-hidden="true" />说说看法</button>
      </div>
      <label htmlFor={`${id}-comment`}>我的补充</label>
      <textarea ref={commentRef} id={`${id}-comment`} rows={2} value={entry.draft.comment} placeholder="说说你的看法，也可以补充当时的情境。"
        onChange={(event) => feedback.setComment(discovery.id, event.target.value)} />
      <div className="overview-feedback-footer">
        <div className="overview-feedback-state" role="status" aria-live="polite">
          {!feedback.canSave && <span>暂时无法保存，草稿仅保留在本次浏览中。</span>}
          {entry.submitting && <span>正在提交…</span>}
          {!entry.submitting && entry.error && <span>提交失败。请重试上次内容，或提交当前草稿。</span>}
          {!entry.submitting && !entry.error && entry.receiptMatchesDraft &&
            <span>{entry.receipt?.persistence === 'saved' ? '已保存' : '模拟完成 · 未保存'}</span>}
          {!entry.submitting && !entry.error && !entry.receiptMatchesDraft && feedback.canSave && entry.isDirty &&
            <span>有未提交的修改</span>}
          {entry.receipt?.analysis === 'pending' && <span className="overview-feedback-analysis">待后续分析</span>}
        </div>
        <div className="overview-feedback-submit">
          {entry.error && <button type="button" disabled={entry.submitting || !feedback.canSave}
            onClick={() => { void feedback.retry(discovery.id) }}>重试上次提交</button>}
          <button type="submit" disabled={entry.submitting || !feedback.canSave || !entry.isDirty}>提交反馈</button>
        </div>
      </div>
    </form>
  </article>
}

export function PersonalOverview({ data, concealed = false, status = 'ready', retry, headingRef, onReturnToCover, onImport, onOpenConversation, conversationTitle, hasRelationshipObservations, children, onOpenMemory, onOpenSource, isSourceAvailable, feedback }: PersonalOverviewProps) {
  const discoveries = data?.discoveries ?? noDiscoveries
  const initialize = feedback.initialize
  useEffect(() => { initialize(discoveries) }, [discoveries, initialize])
  const summary = dimensionKeys.map(axis => {
    const estimate = data?.preferences?.[personalityDimensions[axis].id]
    return estimate?.status === 'known' && estimate.leaning !== 'balanced'
      ? axis[estimate.leaning === 'left' ? 0 : 1] : '?'
  }).join('')
  const visibleDiscoveries = discoveries.map((discovery) => ({ discovery, scenes: contextualScenes(discovery) }))
    .filter(({ discovery, scenes }) => discovery.observation.trim() && scenes.length)
  const hasKnownPreferences = dimensionKeys.some(axis => {
    const estimate = data?.preferences?.[personalityDimensions[axis].id]
    return estimate && estimate.status !== 'unknown'
  })
  const noRecords = !data || data.materialStatus === 'none'
  const noAnalysis = data?.materialStatus === 'unanalysed'
  return <div className="personal-overview">
    <button type="button" className="overview-return" aria-label="返回 Hello" onClick={onReturnToCover}><ArrowLeft aria-hidden="true" />返回</button>
    <h1 ref={headingRef} tabIndex={-1}>个人总览</h1>
    <section className="overview-personality" aria-labelledby="overview-personality-title">
      <div className="overview-personality-header"><h2 id="overview-personality-title">你的人格倾向</h2>
        {!concealed && status === 'ready' && hasKnownPreferences && <div className="overview-estimate"><span className="overview-estimate-label">当前推测</span>
          <strong className="overview-type" aria-label="当前推测类型">{summary}</strong></div>}
      </div>
      {concealed ? <div className="overview-preferences">{dimensionKeys.map(axis => <div key={axis} className="overview-preference-row">
        <strong>{personalityDimensions[axis].name}</strong><span className="overview-masked-value" aria-hidden="true" /></div>)}</div>
      : status !== 'ready' ? <div className="overview-start" role={status === 'loading' ? 'status' : 'alert'}>
        {status === 'loading' ? '正在读取个人总览…' : <>读取总览失败。 <button className="page-secondary" type="button" onClick={retry}>重试</button></>}
      </div> : <>{noRecords || noAnalysis ? <div className="overview-start">
        <p>{noRecords ? '导入一段聊天，回看自己在不同关系里的习惯。' : conversationTitle ? <>从「{conversationTitle}」开始，整理你们的第一份记忆。</> : '选择一段聊天，整理你们的第一份记忆。'}</p>
        {(noRecords || onOpenConversation) && <button type="button" className="page-primary" onClick={noRecords ? onImport : onOpenConversation}>
          {noRecords ? <FileInput aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}{noRecords ? '导入聊天记录' : '打开会话整理'}</button>}
      </div> : data?.materialStatus === 'partial' && <p className="overview-material-note">当前观察仅来自已分析的部分记录。</p>}
      <div className="overview-preferences">
        {dimensionKeys.map(axis => <PreferenceRow key={axis} axis={axis} estimate={data?.preferences?.[personalityDimensions[axis].id] ?? unknownEstimate} />)}
      </div>
      {!noRecords && onOpenMemory && !hasRelationshipObservations && <button className="overview-return" type="button" onClick={onOpenMemory}>查看记忆<ChevronRight aria-hidden="true" /></button>}
      {children}</>}
      </section>
      <section className="overview-sparks" aria-labelledby="overview-sparks-title">
        <div className="overview-sparks-header"><h2 id="overview-sparks-title"><span>Spark</span> · 不一样的自己</h2><div aria-hidden="true" /></div>
        {!concealed && status === 'ready' && (visibleDiscoveries.length ? visibleDiscoveries.map(({ discovery, scenes }) => <SparkArticle key={discovery.id}
          discovery={discovery} scenes={scenes} feedback={feedback} onOpenSource={onOpenSource} isSourceAvailable={isSourceAvailable} />)
          : <div className="overview-spark-empty"><Sparkles className="spark-mark" aria-hidden="true" /><p>还没有可查看的发现。<small>这里收藏有聊天片段作为依据的观察。</small></p></div>)}
      </section>
  </div>
}
