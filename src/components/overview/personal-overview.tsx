import { useEffect, useId, useRef, type CSSProperties, type RefObject } from 'react'
import { ArrowLeft, ChevronRight, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { OverviewData, PreferenceEstimate, PreferenceId, SourceReference, SparkDiscovery, SparkScene } from './types'
import type { useOverviewFeedback } from './use-overview-feedback'
import './personal-overview.css'

interface PersonalOverviewProps {
  data?: OverviewData
  headingRef: RefObject<HTMLHeadingElement | null>
  onReturnToCover: () => void
  onImport: () => void
  onOpenSource: (source: SourceReference) => void
  isSourceAvailable: (source: SourceReference) => boolean
  feedback: ReturnType<typeof useOverviewFeedback>
}

const preferences: readonly {
  id: PreferenceId; left: string; right: string; leftLetter: string; rightLetter: string; description: string
  leftContext: string; rightContext: string
}[] = [
  { id: 'energy', left: '外向', right: '内向', leftLetter: 'E', rightLetter: 'I', description: '互动或独处中恢复精力。',
    leftContext: '更习惯从互动中恢复精力。', rightContext: '更习惯从独处中恢复精力。' },
  { id: 'information', left: '实感', right: '直觉', leftLetter: 'S', rightLetter: 'N', description: '具体经验与关联可能。',
    leftContext: '更常从具体经验和细节理解事情。', rightContext: '更常留意事物间的关联和可能。' },
  { id: 'decisions', left: '思考', right: '情感', leftLetter: 'T', rightLetter: 'F', description: '逻辑与感受在决策中的侧重。',
    leftContext: '做决定时更侧重逻辑与一致性。', rightContext: '做决定时更侧重感受与对人的影响。' },
  { id: 'approach', left: '判断', right: '感知', leftLetter: 'J', rightLetter: 'P', description: '提前安排与保留弹性。',
    leftContext: '更习惯提前安排和确定计划。', rightContext: '更习惯保留弹性和临场调整。' },
]

const unknownEstimate: PreferenceEstimate = { status: 'unknown' }
const noDiscoveries: readonly SparkDiscovery[] = []

function PreferenceRow({ preference, estimate }: { preference: typeof preferences[number]; estimate: PreferenceEstimate }) {
  const { left, right, leftLetter, rightLetter } = preference
  const name = `${left} ${leftLetter} / ${right} ${rightLetter}`
  const balanced = estimate.status === 'known' && estimate.leaning === 'balanced'
  const leaningLeft = estimate.status === 'known' && estimate.leaning === 'left'
  const strength = estimate.status === 'known' && estimate.strength === 'clear' ? '偏向' : '略偏'
  const result = estimate.status === 'unknown' ? '尚待了解' : balanced ? '较均衡' : `${strength}${leaningLeft ? left : right}`
  const marker = balanced ? '50%' : leaningLeft ? (estimate.status === 'known' && estimate.strength === 'clear' ? '17%' : '34%')
    : (estimate.status === 'known' && estimate.strength === 'clear' ? '83%' : '66%')
  const description = estimate.status === 'unknown' ? estimate.reason || '材料还不足以判断。'
    : estimate.context || (balanced ? `在${left}与${right}之间，没有明显偏向。` : leaningLeft ? preference.leftContext : preference.rightContext)

  return <div className="overview-preference-row" role="group" aria-label={name}>
    <div className="overview-preference-name"><h3>{name}</h3><p>{preference.description}</p></div>
    {estimate.status === 'unknown'
      ? <div className="overview-preference-unknown" aria-label="倾向未知">?</div>
      : <div className="overview-preference-gauge" role="img"
        aria-label={balanced ? `${left}与${right}较均衡，标记位于中点` : `${result}，仅表示定性倾向`}>
        <span aria-hidden="true">{leftLetter}</span>
        <div className="overview-preference-track" style={{ '--preference-marker': marker } as CSSProperties} aria-hidden="true">
          <i /><i /><i /><i /><i /><b />
        </div>
        <span aria-hidden="true">{rightLetter}</span>
      </div>}
    <div className="overview-preference-result"><strong>{result}</strong><p>{description}</p></div>
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

export function PersonalOverview({ data, headingRef, onReturnToCover, onImport, onOpenSource, isSourceAvailable, feedback }: PersonalOverviewProps) {
  const discoveries = data?.discoveries ?? noDiscoveries
  const initialize = feedback.initialize
  useEffect(() => { initialize(discoveries) }, [discoveries, initialize])
  const summary = preferences.map((preference) => {
    const estimate = data?.preferences?.[preference.id]
    return estimate?.status === 'known' && estimate.leaning !== 'balanced'
      ? estimate.leaning === 'left' ? preference.leftLetter : preference.rightLetter : '?'
  }).join('')
  const balancedPreferences = preferences.filter((preference) => {
    const estimate = data?.preferences?.[preference.id]
    return estimate?.status === 'known' && estimate.leaning === 'balanced'
  })
  const visibleDiscoveries = discoveries.map((discovery) => ({ discovery, scenes: contextualScenes(discovery) }))
    .filter(({ discovery, scenes }) => discovery.observation.trim() && scenes.length)

  return <div className="personal-overview">
    <button type="button" className="overview-return" aria-label="返回 Hello" onClick={onReturnToCover}><ArrowLeft aria-hidden="true" />返回</button>
    <h1 ref={headingRef} tabIndex={-1}>个人总览</h1>
    {!data && <div className="overview-material-state">
      <h2>还没有可查看的总览。</h2>
      <p>完成会话导入与分析后，可在这里查看自己的概览。</p>
      <button type="button" onClick={onImport}>选择记录</button>
    </div>}
    {data?.materialStatus === 'none' && <div className="overview-material-state">
      <h2>还没有可查看的总览。</h2>
      <p>选择想要了解的会话记录。</p>
      <button type="button" onClick={onImport}>选择记录</button>
    </div>}
    {data?.materialStatus === 'unanalysed' && <p className="overview-material-note">已有记录，尚未形成分析结果。</p>}
    {data?.materialStatus === 'partial' && <p className="overview-material-note">当前观察仅来自已分析的部分记录。</p>}
    <section className="overview-personality" aria-labelledby="overview-personality-title">
      <div className="overview-personality-header">
        <h2 id="overview-personality-title">人格偏好</h2>
        <span className="overview-estimate-label">当前推测</span>
        <strong className="overview-type" aria-label="当前推测类型">{summary}</strong>
      </div>
      <div className="overview-preferences">
        {preferences.map((preference) => <PreferenceRow key={preference.id} preference={preference}
          estimate={data?.preferences?.[preference.id] ?? unknownEstimate} />)}
      </div>
      <p className="overview-type-explanation">材料不足的维度保留问号。
        {balancedPreferences.map((preference) => <span key={preference.id}>{preference.left}与{preference.right}这一位较均衡，因此保留问号。</span>)}
      </p>
    </section>
    <section className="overview-sparks" aria-labelledby="overview-sparks-title">
      <div className="overview-sparks-header"><h2 id="overview-sparks-title"><span>Spark</span> · 不一样的自己</h2><div aria-hidden="true" /></div>
      {visibleDiscoveries.length ? visibleDiscoveries.map(({ discovery, scenes }) => <SparkArticle key={discovery.id}
        discovery={discovery} scenes={scenes} feedback={feedback} onOpenSource={onOpenSource} isSourceAvailable={isSourceAvailable} />)
        : <p className="overview-spark-empty">还没有可查看的发现。</p>}
    </section>
  </div>
}
