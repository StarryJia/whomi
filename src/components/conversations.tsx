import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { actionError, ManagedRow, ReaderDialog } from './ui/managed-row'
import { ArrowLeft, ChevronRight, MousePointer2, Plus, UserRound } from 'lucide-react'
import clsx from 'clsx'
import { Tooltip } from './ui/tooltip'
import type { SourceReference } from './overview/types'
import type { MessagePosition, MessageView, DesktopApi, MemberView, ListArrangement } from '../shared/desktop-api'
import { useMessageSelection } from './conversation-ai/selection'
import { ConversationWorkspace } from './conversation-ai/workspace'
import type { ConversationAiAdapter } from './conversation-ai/types'

export interface ChatMessage {
  id: string
  sender: string
  text: string
  isSelf?: boolean
  time?: string
}

export interface Conversation {
  id: string
  title: string
  messages: readonly ChatMessage[]
}

export function resolveSourceRange(conversations: readonly Conversation[], source: SourceReference) {
  if (source.unavailable) return null
  const conversation = conversations.find(item => item.id === source.conversationId)
  if (!conversation) return null
  const startIndex = conversation.messages.findIndex(message => message.id === source.messageId)
  const endIndex = source.endMessageId
    ? conversation.messages.findIndex(message => message.id === source.endMessageId)
    : startIndex
  if (startIndex < 0 || endIndex < startIndex) return null
  return { conversation, startIndex, endIndex }
}

function Initial({ name }: { name: string }) {
  return <span className="conversation-avatar" aria-hidden="true">{[...name.trim()][0] || '·'}</span>
}

export function ConversationNavigation({ wide, conversations, activeId, onSelect, onImport, hasMore, loading, error, onLoadMore, onRefresh, arrange, remove }: {
  wide: boolean
  conversations: readonly { id: string; title: string; pinned?: boolean }[]
  arrange?: (change: ListArrangement) => Promise<void>
  remove?: (id: string) => Promise<void>
  activeId?: string
  onSelect: (id: string) => void
  onImport: () => void
  hasMore?: boolean
  loading?: boolean
  error?: string
  onLoadMore?: () => void
  onRefresh?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toggleLabel = expanded ? '收起会话列表' : '展开会话列表'
  return (
    <section className="conversation-navigation" aria-label="会话">
      <div className={clsx('conversation-toolbar', wide && 'conversation-menu-wide')} role="group" aria-label="会话菜单">
        <Tooltip content={toggleLabel}>
          <button className="nav-control conversation-toggle" type="button" aria-label={toggleLabel}
            aria-expanded={expanded} aria-controls="conversation-list" onClick={() => setExpanded(!expanded)}>
            <span className="control-icon"><ChevronRight className={clsx('drawer-chevron', expanded && 'is-expanded')} aria-hidden="true" /></span>
            <span className="control-label" aria-hidden="true">会话</span>
          </button>
        </Tooltip>
        {wide && <>
          <Tooltip content="导入会话">
            <button className="conversation-tool" type="button" aria-label="导入会话" onClick={onImport}><Plus aria-hidden="true" /></button>
          </Tooltip>
        </>}
      </div>
      <div id="conversation-list" className={clsx('conversation-drawer', expanded && 'is-expanded')}
        aria-label="会话列表" aria-hidden={!expanded} inert={!expanded}>
        <div className="conversation-drawer-inner">
          {conversations.length > 0 && <ul className="conversation-list">
            {conversations.map(conversation => <li key={conversation.id}>
              <ManagedRow item={conversation} scope="conversations" className="conversation-item" active={activeId === conversation.id}
                onSelect={() => onSelect(conversation.id)} arrange={arrange} remove={remove && (() => remove(conversation.id))}>
                <Initial name={conversation.title} />
                {wide && <span className="conversation-name">{conversation.title}</span>}
              </ManagedRow>
            </li>)}
          </ul>}
          {hasMore && <button className="conversation-load" type="button" disabled={loading} onClick={onLoadMore}>加载更多会话</button>}
          {error && <div className="conversation-list-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh}>重试会话列表</button></div>}
        </div>
      </div>
    </section>
  )
}

function comparePosition(left: MessagePosition, right: MessagePosition) {
  if (left.timeBucket !== right.timeBucket) return left.timeBucket - right.timeBucket
  if (left.sortTime !== right.sortTime) return left.sortTime < right.sortTime ? -1 : 1
  if (left.id === right.id) return 0
  // 本地编号可能超过 JavaScript 安全整数，不能先转换为 Number。
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) return BigInt(left.id) < BigInt(right.id) ? -1 : 1
  return left.id < right.id ? -1 : 1
}
function messageTime(message: MessageView) {
  if (message.timeBucket === 1 || message.sentAtMs === null) return message.timeRaw
  const date = new Date(message.sentAtMs)
  return Number.isNaN(date.getTime()) ? message.timeRaw : date.toLocaleString('zh-CN')
}
const messageKinds: Record<MessageView['kind'], string> = {
  text: '文字', image: '图片', audio: '语音', video: '视频', file: '文件', sticker: '表情', link: '链接',
  location: '位置', reply: '引用', forward: '转发', system: '系统', unknown: '未知类型',
}

type QuoteJump = { targetId: string; originId?: string; referenceIds?: readonly string[]; pending?: boolean }

export function ConversationReader({ conversation, initialAnalysisTaskId, openAnalysisOnEntry, range, sourceStatus, onReturn, returnLabel = '返回个人总览',
  beforeCursor, afterCursor, onBefore, onAfter, loading, error, onRetry, messageCount, aiAdapter,
  onLocateMessageId, api, onSelfChanged, onConfigureModels, onOpenMemory }: {
  initialAnalysisTaskId?: string
  openAnalysisOnEntry?: boolean
  conversation: { id: string; title: string; messages: readonly MessageView[] }
  range?: { start: MessagePosition; end: MessagePosition }
  sourceStatus?: 'loading' | 'available' | 'unavailable'
  onReturn?: () => void
  returnLabel?: string
  beforeCursor?: string | null
  afterCursor?: string | null
  onBefore?: () => Promise<void>
  onAfter?: () => Promise<void>
  loading?: boolean
  error?: string
  onRetry?: () => void
  preview?: boolean
  messageCount?: number
  aiAdapter?: ConversationAiAdapter
  onLocateMessageId?: (messageId: string) => Promise<boolean>
  api?: Pick<DesktopApi, 'listMembers' | 'confirmSelf'>
  onConfigureModels?: (onReturn: () => void) => void
  onOpenMemory?: (taskId: string) => void
  onSelfChanged?: () => Promise<void> | void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const firstSource = useRef<HTMLLIElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const anchors = useRef<Array<{ id: string; top: number }>>([])
  const firstMessage = conversation.messages[0]?.id
  const previousFirst = useRef(firstMessage)
  const [selectionMode, setSelectionMode] = useState(false)
  const selectionButton = useRef<HTMLButtonElement>(null)
  const selection = useMessageSelection(conversation.messages, selectionMode)
  const [jump, setJump] = useState<QuoteJump>()
  const [highlightedReferences, setHighlightedReferences] = useState<{ ids: ReadonlySet<string>; pending?: boolean }>()
  const [quoteReturnId, setQuoteReturnId] = useState<string>()
  const [quoteBusy, setQuoteBusy] = useState(false)
  const [quoteFailure, setQuoteFailure] = useState<QuoteJump>()
  const quoteGeneration = useRef(0)
  const activeQuote = useRef<QuoteJump | undefined>(undefined)
  const [focusedMessageId, setFocusedMessageId] = useState<string>()
  const tabStopId = conversation.messages.some(item => item.id === focusedMessageId) ? focusedMessageId : firstMessage

  const selfButton = useRef<HTMLButtonElement>(null)

  const [selfModalOpen, setSelfModalOpen] = useState(false)
  const [members, setMembers] = useState<MemberView[]>([])
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [selfLoading, setSelfLoading] = useState(false)
  const [selfSaving, setSelfSaving] = useState(false)
  const [identityRevision, setIdentityRevision] = useState(0)
  const [selfError, setSelfError] = useState<string>()

  const [selfReadFailed, setSelfReadFailed] = useState(false)
  const [showSelfHint, setShowSelfHint] = useState(false)
  const selfRequest = useRef(0)
  const selfCard = useRef<HTMLDivElement>(null)
  const selfFlight = useRef<Animation | null>(null)

  async function readMembers(onEntry: boolean) {
    const sequence = ++selfRequest.current
    setSelfError(undefined)
    setSelfReadFailed(false)
    setSelfLoading(true)
    setMembers([])
    setSelectedMemberId(null)
    if (!onEntry) setSelfModalOpen(true)
    try {
      const list = api?.listMembers ? await api.listMembers(conversation.id) : [...new Set(conversation.messages.map(m => m.senderName))].map((name, index) => ({
        id: String(index + 1), displayName: name, selfHint: null,
        confirmedSelf: conversation.messages.some(m => m.senderName === name && m.isSelf),
      }))
      if (sequence !== selfRequest.current) return
      const confirmed = list.find(member => member.confirmedSelf)
      setMembers(list)
      setSelectedMemberId(confirmed?.id ?? null)
      if (onEntry && !confirmed) setSelfModalOpen(true)
    } catch (err) {
      if (sequence !== selfRequest.current) return
      setSelfError(actionError(err))
      setSelfReadFailed(true)
      setSelfModalOpen(true)
    } finally {
      if (sequence === selfRequest.current) setSelfLoading(false)
    }
  }

  useEffect(() => {
    setSelfModalOpen(false)
    setShowSelfHint(false)
    if (api?.listMembers) void readMembers(true)
    return () => {
      selfRequest.current++
      selfFlight.current?.cancel()
      selfFlight.current = null
    }
  }, [conversation.id, api?.listMembers])

  useEffect(() => {
    if (!showSelfHint) return
    const timer = setTimeout(() => setShowSelfHint(false), 6000)
    return () => clearTimeout(timer)
  }, [showSelfHint])

  function dismissIdentity() {
    if (selfSaving || selfFlight.current) return
    ++selfRequest.current
    const guide = !members.some(member => member.confirmedSelf)
    const finish = () => { setSelfModalOpen(false); setShowSelfHint(guide) }
    const card = selfCard.current, target = selfButton.current?.getBoundingClientRect()
    if (!guide || !card?.animate || !target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return }
    const start = card.getBoundingClientRect()
    const dx = target.left + target.width / 2 - start.left - start.width / 2
    const dy = target.top + target.height / 2 - start.top - start.height / 2
    const animation = card.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.08)`, opacity: 0 }],
      { duration: 230, easing: 'cubic-bezier(.4,0,.25,1)', fill: 'forwards' })
    selfFlight.current = animation
    animation.onfinish = () => { selfFlight.current = null; finish() }
  }

  async function handleConfirmSelf(memberId: string | null) {
    if (selfFlight.current || selfSaving) return
    setSelfSaving(true)
    setSelfError(undefined)
    try {
      if (api?.confirmSelf) {
        await api.confirmSelf(conversation.id, memberId)
      }
      setSelfModalOpen(false)
      setIdentityRevision(revision => revision + 1)
      await onSelfChanged?.()
    } catch (err) {
      setSelfError(actionError(err))
    } finally {
      setSelfSaving(false)
    }
  }

  useLayoutEffect(() => {
    setSelectionMode(false)
    selection.clear()
  }, [conversation.id, selection.clear])

  useEffect(() => () => { quoteGeneration.current++ }, [conversation.id])

  const endReferenceView = useCallback(() => {
    ++quoteGeneration.current
    activeQuote.current = undefined
    setJump(undefined)
    setHighlightedReferences(undefined)
    setQuoteReturnId(undefined)
    setQuoteFailure(undefined)
    setQuoteBusy(false)
  }, [])

  useLayoutEffect(() => {
    const request = activeQuote.current
    if (!request?.pending) return
    if (!selection.selectedIds.has(request.targetId)) { endReferenceView(); return }
    const ids = request.referenceIds?.filter(id => selection.selectedIds.has(id))
    if (ids?.length === request.referenceIds?.length) return
    const retained = { ...request, referenceIds: ids }
    activeQuote.current = retained
    setHighlightedReferences(current => current?.pending ? { ...current, ids: new Set(ids) } : current)
    setJump(current => current?.pending ? retained : current)
    setQuoteFailure(current => current?.pending ? retained : current)
  }, [selection.selectedIds, endReferenceView])

  function toggleSelectionMode() {
    if (!selectionMode) endReferenceView()
    setSelectionMode(active => !active)
  }

  async function navigateQuote(request: QuoteJump) {
    endReferenceView()
    const generation = quoteGeneration.current
    activeQuote.current = request
    setQuoteBusy(true)
    setQuoteFailure(undefined)
    try {
      if (quoteBusy || !conversation.messages.some(message => message.id === request.targetId)) {
        if (!onLocateMessageId || !await onLocateMessageId(request.targetId)) throw new Error('unavailable')
      }
      const current = activeQuote.current
      if (generation !== quoteGeneration.current || !current) return
      setJump({ ...current })
      setHighlightedReferences(current.referenceIds ? { ids: new Set(current.referenceIds), pending: current.pending } : undefined)
      setQuoteReturnId(current.originId)
    } catch {
      if (generation === quoteGeneration.current) setQuoteFailure(activeQuote.current)
    } finally {
      if (generation === quoteGeneration.current) setQuoteBusy(false)
    }
  }

  useLayoutEffect(() => {
    if (!jump) return
    const element = Array.from(scroll.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find(item => item.dataset.messageId === jump.targetId)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView?.({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [jump])

  useEffect(() => {
    if (!jump) return
    const timer = window.setTimeout(() => setJump(undefined), 1800)
    return () => window.clearTimeout(timer)
  }, [jump])

  function rememberPosition() {
    const container = scroll.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    anchors.current = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).flatMap(element => {
      const rectangle = element.getBoundingClientRect()
      return rectangle.bottom > top ? [{ id: element.dataset.messageId!, top: rectangle.top - top }] : []
    })
  }

  useLayoutEffect(() => {
    const container = scroll.current
    if (container && previousFirst.current !== firstMessage) {
      const positions = new Map(Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).map(element => [element.dataset.messageId, element]))
      const retained = anchors.current.find(anchor => positions.has(anchor.id))
      if (retained) container.scrollTop += positions.get(retained.id)!.getBoundingClientRect().top - container.getBoundingClientRect().top - retained.top
    }
    previousFirst.current = firstMessage
    rememberPosition()
  }, [firstMessage, conversation.messages])

  useLayoutEffect(() => {
    const container = scroll.current
    if (!container || typeof ResizeObserver === 'undefined') return
    let width = container.clientWidth
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === width) return
      width = container.clientWidth
      const retained = anchors.current.find(anchor => Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
        .some(element => element.dataset.messageId === anchor.id))
      if (retained) {
        const element = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === retained.id)!
        container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - retained.top
      }
      rememberPosition()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (quoteBusy || jump) return
    if (firstSource.current) {
      firstSource.current.focus({ preventScroll: true })
      firstSource.current.scrollIntoView?.({ block: 'center', behavior: 'auto' })
    } else heading.current?.focus()
  }, [conversation.id, sourceStatus, range?.start.id, range?.end.id])

  async function load(direction: 'before' | 'after') {
    rememberPosition()
    await (direction === 'before' ? onBefore?.() : onAfter?.())
  }

  return <ConversationWorkspace initialAnalysisTaskId={initialAnalysisTaskId} openAnalysisOnEntry={openAnalysisOnEntry} onConfigureModels={onConfigureModels} onOpenAnalysisResult={onOpenMemory} conversationId={conversation.id} identityRevision={identityRevision} title={conversation.title} messageCount={messageCount}
    references={selection.references} onClearReferences={selection.clear} onRestoreReferences={selection.restore}
    onEndReferenceView={endReferenceView}
    onJumpReference={(ids, targetId = ids[0], pending) => { if (targetId) void navigateQuote({ targetId, referenceIds: ids, pending }) }} adapter={aiAdapter}>
    {({ analysisControl, chatControl, composer }) => <section className="conversation-reader" aria-labelledby="conversation-title" onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !selectionMode) return
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      setSelectionMode(false)
      selectionButton.current?.focus({ preventScroll: true })
    }}>
    <header className="reader-header">
      {onReturn && <button className="reader-return" type="button" onClick={onReturn}>
        <ArrowLeft aria-hidden="true" />{returnLabel}
      </button>}
      <div className="reader-heading-row"><h1 id="conversation-title" ref={heading} tabIndex={-1}>{conversation.title}</h1>
        <div className="reader-actions">
          <button ref={selectionButton} className="reader-selection-toggle" type="button" aria-label="选择消息"
            title={selectionMode ? '退出选择' : '选择消息'} aria-pressed={selectionMode} onClick={toggleSelectionMode}>
            <MousePointer2 aria-hidden="true" />
          </button>
          {analysisControl}
          {chatControl}
          <div className="reader-identity-entry">
            <button ref={selfButton} className="reader-identity-toggle" type="button" aria-label="选择本人"
              title="选择本人" aria-haspopup="dialog" aria-expanded={selfModalOpen} onClick={() => { setShowSelfHint(false); void readMembers(false) }}>
              <UserRound aria-hidden="true" />
            </button>
            {showSelfHint && <span role="status" className="reader-identity-hint">可在这里选择本人</span>}
          </div>
        </div>
      </div>
      {quoteReturnId && <button className="reader-return reader-quote-return" type="button" disabled={quoteBusy}
        onClick={() => { void navigateQuote({ targetId: quoteReturnId }) }}><ArrowLeft aria-hidden="true" />返回引用位置</button>}
      {quoteFailure && (!quoteFailure.pending || selection.selectedIds.has(quoteFailure.targetId)) && <p className="reader-source-note" role="alert">未找到原消息，请重试。{' '}
        <button type="button" onClick={() => { void navigateQuote(quoteFailure) }}>重试定位</button></p>}
      {sourceStatus && <p className="reader-source-note" role="status">{sourceStatus === 'available'
        ? '已定位相关交流，可继续阅读前后文。' : sourceStatus === 'loading' ? '正在定位原文…' : '原文不可用，请返回后重试。'}</p>}
      {error && <p className="reader-source-note" role="alert">{error} <button type="button" onClick={onRetry}>重新打开会话</button></p>}
    </header>
    <div ref={scroll} className={clsx('reader-scroll', selectionMode && 'reader-selecting')} role="region" aria-label="聊天记录" tabIndex={0} aria-busy={loading} onScroll={rememberPosition}>
      {beforeCursor && <button className="reader-load" type="button" disabled={loading} onClick={() => { void load('before') }}>加载前文</button>}
      {conversation.messages.length ? <ol className="message-list" role={selectionMode ? 'listbox' : undefined}
        aria-label={selectionMode ? '选择引用消息' : '会话消息'} aria-multiselectable={selectionMode ? true : undefined}>
        {conversation.messages.map((message, index) => {
          const start = range?.start.id === message.id
          const end = range?.end.id === message.id
          const highlighted = range && comparePosition(message, range.start) >= 0 && comparePosition(message, range.end) <= 0
          const selected = selection.selectedIds.has(message.id)
          const referenced = highlightedReferences?.ids.has(message.id) && (!highlightedReferences.pending || selected)
          const jumpTarget = jump?.targetId === message.id && (!jump.pending || selected)
          const joinedBefore = selected && index > 0 && selection.selectedIds.has(conversation.messages[index - 1].id)
          const joinedAfter = selected && index < conversation.messages.length - 1 && selection.selectedIds.has(conversation.messages[index + 1].id)
          return <li key={message.id} data-message-id={message.id}
          ref={start ? firstSource : undefined}
          role={selectionMode ? 'option' : undefined} aria-selected={selectionMode ? selected : undefined} aria-label={`${message.senderName}：${message.text || messageKinds[message.kind]}`}
          tabIndex={selectionMode && tabStopId === message.id ? 0 : -1} {...(selectionMode ? selection.bindings(message) : {})} onFocus={() => setFocusedMessageId(message.id)}
          className={clsx('message', message.isSelf && 'message-self', highlighted && 'message-source', selected && 'message-selected',
            joinedBefore && 'selection-joined-before', joinedAfter && 'selection-joined-after',
            (referenced || jumpTarget) && 'message-reference-target')}>
          <Initial name={message.senderName} />
          <div className="message-content">
            {message.timeBucket === 1 && (index === 0 || conversation.messages[index - 1].timeBucket !== 1) && <p className="message-time-unknown">时间未知</p>}
            <div className="message-meta"><span>{message.senderName}</span>{messageTime(message) && <span>{messageTime(message)}</span>}{start && <span className="source-range-label">引用范围起点</span>}{end && !start && <span className="source-range-label">引用范围终点</span>}</div>
            <p className="message-text">{message.text}</p>
            {message.reply && (() => {
              const targetId = message.reply.targetMessageId
              const target = conversation.messages.find(item => item.id === targetId)
              const sender = message.reply.senderName ?? target?.senderName
              const text = message.reply.text ?? target?.text ?? '原消息'
              const content = <>{sender && <strong>{sender}</strong>}<span>{text}</span></>
              return message.reply.state === 'resolved' && targetId && (target || onLocateMessageId)
                ? <button className="message-quote is-linked" type="button" disabled={quoteBusy}
                  aria-label={`查看引用原消息：${sender ? `${sender}：` : ''}${text.slice(0, 120)}`} title={text}
                  onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
                  onClick={event => { event.stopPropagation(); void navigateQuote({ targetId, originId: message.id }) }}>{content}</button>
                : <blockquote className="message-quote" title={text}>{content}</blockquote>
            })()}
          </div>
        </li>})}
      </ol> : !loading && !error && !sourceStatus ? <p className="reader-empty">这段会话还没有聊天记录。</p> : null}
      {loading && !sourceStatus && <p className="reader-empty" role="status">正在读取…</p>}
      {afterCursor && <button className="reader-load" type="button" disabled={loading} onClick={() => { void load('after') }}>加载后文</button>}
    </div>
    {composer}
    {selfModalOpen && (
      <ReaderDialog busy={selfSaving} onDismiss={dismissIdentity} returnFocus={selfButton} labelledBy="self-modal-title">
      <div className="reader-modal-overlay" role="presentation" onClick={e => { if (e.target === e.currentTarget) dismissIdentity() }}>
        <div className="reader-modal-card" ref={selfCard}>
          <h2 id="self-modal-title">选择本人</h2>
          <p className="reader-modal-description">这段聊天里，哪位是你？</p>
          {selfError && <p className="import-error" role="alert">{selfError} {selfReadFailed && <button type="button" className="reader-modal-btn" onClick={() => void readMembers(false)}>重新读取成员</button>}</p>}
          <div className="reader-modal-body" role="radiogroup" aria-label="成员列表">
            {selfLoading ? <p className="reader-modal-empty">正在读取成员…</p> : selfReadFailed ? null : !members.length ? <p className="reader-modal-empty">该会话暂无成员。</p> : (
              members.map(member => {
                const isSelected = selectedMemberId === member.id
                return (
                  <label key={member.id} className={clsx('reader-member-item', isSelected && 'is-selected')}>
                    <div className="reader-member-info">
                      <input
                        type="radio"
                        name="self-member"
                        value={member.id}
                        checked={isSelected}
                        onChange={() => setSelectedMemberId(member.id)}
                      />
                      <span>{member.displayName}</span>
                    </div>
                    <div className="reader-member-badges">
                      {member.confirmedSelf && <span className="reader-member-badge is-self">当前本人</span>}
                      {!member.confirmedSelf && member.selfHint && <span className="reader-member-badge">来源推测</span>}
                    </div>
                  </label>
                )
              })
            )}
          </div>
          <div className="reader-modal-footer">
            {members.some(m => m.confirmedSelf) && (
              <button
                type="button"
                className="reader-modal-btn"
                disabled={selfSaving}
                onClick={() => { void handleConfirmSelf(null) }}
              >
                清除本人
              </button>
            )}
            <button
              type="button"
              className="reader-modal-btn"
              disabled={selfSaving}
              onClick={dismissIdentity}
            >
              取消
            </button>
            <button
              type="button"
              className="reader-modal-btn reader-modal-btn-primary"
              disabled={selfLoading || selfReadFailed || selfSaving || !selectedMemberId || selectedMemberId === members.find(m => m.confirmedSelf)?.id}
              onClick={() => { void handleConfirmSelf(selectedMemberId) }}
            >
              {selfSaving ? '正在保存…' : '设为本人'}
            </button>
          </div>
        </div>
      </div>
      </ReaderDialog>
    )}
  </section>}
  </ConversationWorkspace>
}
