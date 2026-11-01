import { useLayoutEffect, useRef, type KeyboardEvent, type Ref } from 'react'
import { ArrowUp, Check, ChevronRight, History, Undo2 } from 'lucide-react'
import clsx from 'clsx'
import type { SourceReference } from '../overview/types'
import type { ClarificationController, ClarificationModel, ClarificationQuestion } from './types'
import { ModelSelector, ThinkingSelector } from '../conversation-ai/model-selector'
import '../conversation-ai/workspace.css'
import './clarification-page.css'

const ownPrompt = '我有自己的想法…'

interface ClarificationPageProps {
  question?: ClarificationQuestion
  models: readonly ClarificationModel[]
  controller: ClarificationController
  headingRef: Ref<HTMLHeadingElement>
  onOpenSource: (source: SourceReference) => void
  isSourceAvailable: (source: SourceReference) => boolean
  preview?: boolean
}

export function ClarificationPage({ question, models, controller, headingRef,
  onOpenSource, isSourceAvailable, preview = false }: ClarificationPageProps) {
  return <section className={clsx('clarification-page', !question && 'is-empty')} aria-labelledby="clarification-title">
    <h1 id="clarification-title" ref={headingRef} tabIndex={-1}>问一问</h1>
    <ClarificationQuestionView key={question?.id ?? 'empty'} question={question} models={models}
      controller={controller} onOpenSource={onOpenSource} isSourceAvailable={isSourceAvailable} preview={preview} />
  </section>
}

function ClarificationQuestionView({ question, models, controller, onOpenSource, isSourceAvailable, preview }: Omit<ClarificationPageProps, 'headingRef'>) {
  const id = question?.id ?? ''
  const entry = controller.get(id)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const firstCardRef = useRef<HTMLButtonElement>(null)
  const withdrawRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  const previous = useRef({ mode: entry.mode, submitted: Boolean(entry.receipt), error: entry.error })
  const locked = !question || Boolean(entry.pending || entry.receipt)
  const availableModels = models.filter(model => model.available)
  const selectedModel = availableModels.find(model => model.id === entry.modelId)
  const validModel = !!selectedModel && (!entry.thinkingLevel || selectedModel.thinkingLevels?.includes(entry.thinkingLevel))
  const canSend = controller.canSubmit && !locked && entry.mode === 'own' && Boolean(entry.draft.trim()) && validModel
  const sourceAvailable = Boolean(question?.source && isSourceAvailable(question.source))
  const failedAnswer = entry.failedAnswer
  const canRetry = controller.canSubmit && !locked && Boolean(failedAnswer) &&
    (failedAnswer?.kind !== 'text' || availableModels.some(model => model.id === failedAnswer.modelId && (!failedAnswer.thinkingLevel || model.thinkingLevels?.includes(failedAnswer.thinkingLevel))))

  useLayoutEffect(() => {
    if (!locked && entry.thinkingLevel && !selectedModel?.thinkingLevels?.includes(entry.thinkingLevel)) controller.setThinkingLevel(id, undefined)
  }, [controller.setThinkingLevel, id, locked, selectedModel, entry.thinkingLevel])

  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = '0px'
    field.style.height = `${Math.min(180, Math.max(56, field.scrollHeight))}px`
  }, [entry.draft])

  useLayoutEffect(() => {
    const was = previous.current
    if (entry.error && entry.error !== was.error) {
      if (entry.error === 'withdraw') withdrawRef.current?.focus()
      else retryRef.current?.focus()
    } else if (!was.submitted && entry.receipt) withdrawRef.current?.focus()
    else if (was.submitted && !entry.receipt) {
      if (entry.mode === 'own') fieldRef.current?.focus()
      else firstCardRef.current?.focus()
    } else if (was.mode === 'own' && entry.mode === 'cards') firstCardRef.current?.focus()
    previous.current = { mode: entry.mode, submitted: Boolean(entry.receipt), error: entry.error }
  }, [entry.mode, entry.receipt, entry.error])

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    if (question && canSend) void controller.sendOwn(question, models)
  }

  return <div className="clarification-content">
    {preview && <p className="clarification-preview-label">开发预览 · 全部内容为虚构示例 · 未写入真实存储</p>}
    <div className="clarification-question">
      <h2>{question?.title ?? '目前还没有问题哦'}</h2>
      {question && <>
      <p>{question.context}</p>
      <button className="clarification-source" type="button" disabled={!sourceAvailable}
        onClick={() => { if (sourceAvailable && question.source) onOpenSource(question.source) }}>
        <History aria-hidden="true" />回顾那段情景<ChevronRight aria-hidden="true" />
      </button>
      {!sourceAvailable && <span className="clarification-source-unavailable">原文暂不可用。</span>}</>}
    </div>

    <div className="clarification-answer-area" aria-busy={Boolean(entry.pending)}>
      {entry.receipt ? <div className="clarification-receipt">
        <p className="clarification-receipt-status" role="status"><Check aria-hidden="true" />
          {entry.receipt.persistence === 'preview' ? '已模拟提交，未保存。' : '回答已提交。'}
        </p>
        <p className="clarification-submitted-answer">{entry.answer?.text}</p>
        <button ref={withdrawRef} className="clarification-secondary" type="button"
          disabled={Boolean(entry.pending) || !controller.canSubmit} onClick={() => void controller.withdraw(id)}>
          <Undo2 aria-hidden="true" />{entry.pending === 'withdraw' ? '正在撤回…' : entry.error === 'withdraw' ? '重试撤回' : '撤回回答'}
        </button>
      </div> : <>
        {question && <p className="clarification-choice-hint" id="clarification-choice-hint">
          {entry.mode === 'own' ? '自己回答' : !controller.canSubmit ? '暂时无法提交回答。' : '点击卡牌即提交，可撤回。'}
        </p>}
        <div data-count={Math.min(question?.options.length ?? 3, 5)} className={clsx('clarification-cards', entry.mode === 'own' && 'is-inactive')}
          role="group" aria-label="预置回答" aria-describedby={question ? "clarification-choice-hint" : undefined}>
          {!question && [0, 1, 2].map(i => <div key={i} className="clarification-card blank-card" aria-hidden="true" />)}
          {question?.options.slice(0, 5).map((option, index) => <button key={option.id} ref={index === 0 ? firstCardRef : undefined}
            className={clsx('clarification-card', entry.pending === 'submit' && entry.answer?.kind === 'option' && entry.answer.optionId === option.id && 'is-submitting')}
            type="button" aria-label={option.title} aria-describedby={option.description ? `clarification-option-${index}` : undefined}
            disabled={entry.mode === 'own' || locked || !controller.canSubmit}
            onClick={() => void controller.choose(question, option.id)}>
            <strong>{option.title}</strong>
            {option.description && <span id={`clarification-option-${index}`}>{option.description}</span>}
          </button>)}
        </div>
      </>}
      <div className="clarification-status">
        {entry.pending === 'submit' && <p role="status">正在提交…</p>}
        {entry.withdrawn && <p role="status">{entry.withdrawn.persistence === 'preview' ? '已模拟撤回，未保存。' : '回答已撤回，可重新作答。'}</p>}
        {entry.error && <div className="clarification-error">
          <p role="alert">{entry.error === 'submit' ? '提交失败，请重试。' : '撤回失败，请重试。'}</p>
          {entry.error === 'submit' && <button ref={retryRef} className="clarification-secondary" type="button" disabled={!canRetry}
            onClick={() => question && void controller.retry(question, models)}>重试提交</button>}
        </div>}
      </div>
    </div>

    {!entry.receipt && <>
      <form className={clsx('clarification-composer conversation-composer', entry.mode === 'own' && !locked && 'is-active')}
        onSubmit={event => { event.preventDefault(); if (question && canSend) void controller.sendOwn(question, models) }}>
        {entry.mode === 'own' && !locked && <div className="clarification-composer-heading">
          <span>自己回答</span>
          <button className="clarification-switch" type="button" onClick={() => controller.useCards(id)}>
            <Undo2 aria-hidden="true" />改用卡牌回答
          </button>
        </div>}
        <textarea ref={fieldRef} aria-label={ownPrompt} placeholder={ownPrompt} value={entry.draft} readOnly={locked} disabled={!question}
          rows={2} onFocus={() => controller.startOwn(id)}
          onChange={event => controller.setDraft(id, event.target.value)}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={handleKeyDown} />
        <div className="conversation-composer-tools">
          <ModelSelector label="选择模型" models={availableModels} value={entry.modelId} disabled={locked || !availableModels.length}
            onSelect={modelId => controller.setModel(id, modelId)} />
          {selectedModel && <ThinkingSelector levels={selectedModel.thinkingLevels} value={entry.thinkingLevel} disabled={locked}
            onSelect={level => controller.setThinkingLevel(id, level)} />}
          <div className="conversation-send-tools"><button className="conversation-send" type="submit" aria-label="发送回答" disabled={!canSend}><ArrowUp aria-hidden="true" /></button></div>
        </div>
      </form>
      {question && <div className="clarification-composer-notes">
        {!controller.canSubmit ? <p>暂时无法提交，草稿仅保留在本次浏览中。</p> :
          !availableModels.length ? <p>暂无可用模型。</p> : <p>Enter 发送 · Shift + Enter 换行</p>}
      </div>}
    </>}
  </div>
}
