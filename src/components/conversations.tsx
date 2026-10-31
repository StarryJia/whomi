import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, Ellipsis, MousePointer2, Plus } from 'lucide-react'
import clsx from 'clsx'
import { Tooltip } from './ui/tooltip'
import type { SourceReference } from './overview/types'
import type { MessagePosition, MessageView, DesktopApi, MemberView } from '../shared/desktop-api'
import { useMessageSelection, type ReferenceRange } from './conversation-ai/selection'
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

function ReaderDialog({ children, busy, onDismiss, returnFocus, labelledBy }: {
  children: ReactNode
  busy: boolean
  onDismiss: () => void
  returnFocus: RefObject<HTMLButtonElement | null>
  labelledBy: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (typeof element.close === 'function') element.close()
      returnFocus.current?.focus({ preventScroll: true })
    }
  }, [returnFocus])
  // 原生模态层隔离侧栏和窗口拖拽区域，并提供浏览器焦点约束。
  return createPortal(<dialog ref={dialog} className="reader-modal-root" aria-modal="true" aria-labelledby={labelledBy}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss() }}>{children}</dialog>, document.body)
}

export function ConversationNavigation({ wide, conversations, activeId, onSelect, onImport, hasMore, loading, error, onLoadMore, onRefresh }: {
  wide: boolean
  conversations: readonly { id: string; title: string }[]
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
          <Tooltip content="管理会话 · 未开放">
            <button className="conversation-tool" type="button" aria-label="管理会话" aria-disabled="true"><Ellipsis aria-hidden="true" /></button>
          </Tooltip>
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
              <Tooltip content={conversation.title}>
                <button className="conversation-item" type="button" aria-label={conversation.title}
                  aria-current={activeId === conversation.id ? 'true' : undefined} onClick={() => onSelect(conversation.id)}>
                  <Initial name={conversation.title} />
                  {wide && <span className="conversation-name">{conversation.title}</span>}
                </button>
              </Tooltip>
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

export function ConversationReader({ conversation, range, sourceStatus, onReturn, returnLabel = '返回个人总览',
  beforeCursor, afterCursor, onBefore, onAfter, loading, error, onRetry, messageCount, aiAdapter, onLocateMessage,
  onLocateMessageId, api, onDeleteConversation, onSelfChanged }: {
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
  onLocateMessage?: (message: MessageView) => Promise<void>
  onLocateMessageId?: (messageId: string) => Promise<boolean>
  api?: Pick<DesktopApi, 'listMembers' | 'confirmSelf' | 'deleteConversation'>
  onDeleteConversation?: (conversationId: string) => Promise<void> | void
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
  const [jumpId, setJumpId] = useState<string>()
  const [quoteReturnId, setQuoteReturnId] = useState<string>()
  const [quoteBusy, setQuoteBusy] = useState(false)
  const [quoteFailure, setQuoteFailure] = useState<{ targetId: string; originId?: string }>()
  const quoteGeneration = useRef(0)
  const [focusedMessageId, setFocusedMessageId] = useState<string>()
  const tabStopId = conversation.messages.some(item => item.id === focusedMessageId) ? focusedMessageId : firstMessage

  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)

  const [selfModalOpen, setSelfModalOpen] = useState(false)
  const [members, setMembers] = useState<MemberView[]>([])
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [selfLoading, setSelfLoading] = useState(false)
  const [selfSaving, setSelfSaving] = useState(false)
  const [selfError, setSelfError] = useState<string>()

  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()

  useEffect(() => {
    if (!moreOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false)
        moreButton.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreOpen])

  useEffect(() => {
    if (!selfModalOpen) return
    setSelfError(undefined)
    setSelfLoading(true)
    if (api?.listMembers) {
      void api.listMembers(conversation.id).then(list => {
        setMembers(list)
        const confirmed = list.find(item => item.confirmedSelf)
        setSelectedMemberId(confirmed ? confirmed.id : null)
      }).catch(err => {
        setSelfError(err instanceof Error ? err.message : '获取成员失败')
      }).finally(() => {
        setSelfLoading(false)
      })
    } else {
      const senders = Array.from(new Set(conversation.messages.map(m => m.senderName)))
      const mockList: MemberView[] = senders.map((name, index) => ({
        id: String(index + 1),
        displayName: name,
        selfHint: null,
        confirmedSelf: conversation.messages.some(m => m.senderName === name && m.isSelf),
      }))
      setMembers(mockList)
      const confirmed = mockList.find(item => item.confirmedSelf)
      setSelectedMemberId(confirmed ? confirmed.id : null)
      setSelfLoading(false)
    }
  }, [selfModalOpen, api, conversation.id, conversation.messages])

  async function handleConfirmSelf(memberId: string | null) {
    setSelfSaving(true)
    setSelfError(undefined)
    try {
      if (api?.confirmSelf) {
        await api.confirmSelf(conversation.id, memberId)
      }
      setSelfModalOpen(false)
      await onSelfChanged?.()
    } catch (err) {
      setSelfError(err instanceof Error ? err.message : '保存本人设置失败')
    } finally {
      setSelfSaving(false)
    }
  }

  async function handleDelete() {
    setDeleteSaving(true)
    setDeleteError(undefined)
    try {
      if (onDeleteConversation) {
        await onDeleteConversation(conversation.id)
      } else if (api?.deleteConversation) {
        await api.deleteConversation(conversation.id)
      }
      setDeleteModalOpen(false)
    } catch (err) {
      console.error('Handle delete error:', (err as { action?: string })?.action ?? err)
      setDeleteError(err instanceof Error ? err.message : '删除会话失败')
      setDeleteSaving(false)
    }
  }

  useLayoutEffect(() => {
    setSelectionMode(false)
    selection.clear()
  }, [conversation.id, selection.clear])

  useEffect(() => () => { quoteGeneration.current++ }, [conversation.id])

  function focusMessage(id: string) {
    const element = Array.from(scroll.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find(item => item.dataset.messageId === id)
    if (!element) return false
    element.focus({ preventScroll: true })
    element.scrollIntoView?.({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    return true
  }

  async function jumpToReference(reference: ReferenceRange) {
    const message = reference.messages[0]
    if (!message) return
    setJumpId(message.id)
    if (!focusMessage(message.id)) await onLocateMessage?.(message)
  }

  async function navigateQuote(request: { targetId: string; originId?: string }) {
    const generation = ++quoteGeneration.current
    setQuoteBusy(true)
    setQuoteFailure(undefined)
    try {
      if (!focusMessage(request.targetId)) {
        if (!onLocateMessageId || !await onLocateMessageId(request.targetId)) throw new Error('unavailable')
      }
      if (generation !== quoteGeneration.current) return
      setJumpId(request.targetId)
      setQuoteReturnId(request.originId)
    } catch {
      if (generation === quoteGeneration.current) setQuoteFailure(request)
    } finally {
      if (generation === quoteGeneration.current) setQuoteBusy(false)
    }
  }

  useLayoutEffect(() => {
    if (jumpId) focusMessage(jumpId)
  }, [jumpId, conversation.messages])

  useEffect(() => {
    if (!jumpId) return
    const timer = window.setTimeout(() => setJumpId(undefined), 1800)
    return () => window.clearTimeout(timer)
  }, [jumpId])

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
    if (quoteBusy || jumpId) return
    if (firstSource.current) {
      firstSource.current.focus({ preventScroll: true })
      firstSource.current.scrollIntoView?.({ block: 'center', behavior: 'auto' })
    } else heading.current?.focus()
  }, [conversation.id, sourceStatus, range?.start.id, range?.end.id])

  async function load(direction: 'before' | 'after') {
    rememberPosition()
    await (direction === 'before' ? onBefore?.() : onAfter?.())
  }

  return <ConversationWorkspace conversationId={conversation.id} title={conversation.title} messageCount={messageCount}
    references={selection.references} onClearReferences={selection.clear} onJumpReference={reference => { void jumpToReference(reference) }} adapter={aiAdapter}>
    {({ analysisControl, chatControl, composer }) => <section className="conversation-reader" aria-labelledby="conversation-title" onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !selectionMode) return
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      setSelectionMode(false)
      selectionButton.current?.focus()
    }}>
    <header className="reader-header">
      {onReturn && <button className="reader-return" type="button" onClick={onReturn}>
        <ArrowLeft aria-hidden="true" />{returnLabel}
      </button>}
      <div className="reader-heading-row"><h1 id="conversation-title" ref={heading} tabIndex={-1}>{conversation.title}</h1>
        <div className="reader-actions">
          <button ref={selectionButton} className="reader-selection-toggle" type="button" aria-label={selectionMode ? '退出选择' : '选择消息'}
            title={selectionMode ? '退出选择' : '选择消息'} aria-pressed={selectionMode} onClick={() => setSelectionMode(value => !value)}>
            <MousePointer2 aria-hidden="true" />
          </button>
          {analysisControl}
          {chatControl}
          <div className="reader-more-wrapper" ref={moreRef}>
            <button ref={moreButton} className="reader-more-toggle" type="button" aria-label="更多操作"
              title="更多操作" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}>
              <Ellipsis aria-hidden="true" />
            </button>
            {moreOpen && <div className="reader-more-menu" role="menu" aria-label="会话管理">
              <button role="menuitem" type="button" className="reader-more-item" onClick={() => { setMoreOpen(false); setSelfModalOpen(true) }}>选择本人</button>
              <button role="menuitem" type="button" className="reader-more-item reader-more-item-danger" onClick={() => { setMoreOpen(false); setDeleteModalOpen(true) }}>删除会话</button>
            </div>}
          </div>
        </div>
      </div>
      {quoteReturnId && <button className="reader-return reader-quote-return" type="button" disabled={quoteBusy}
        onClick={() => { void navigateQuote({ targetId: quoteReturnId }) }}><ArrowLeft aria-hidden="true" />返回引用位置</button>}
      {quoteFailure && <p className="reader-source-note" role="alert">未找到原消息，请重试。{' '}
        <button type="button" onClick={() => { void navigateQuote(quoteFailure) }}>重试定位</button></p>}
      {selectionMode && <div className="reader-selection-hint"><span className="reader-selection-instructions">单击选择，长按后拖动或滚轮多选</span>{selection.selectedIds.size > 0 && <><span role="status">已选 {selection.selectedIds.size} 条</span><button type="button" onClick={selection.clear}>取消选择</button></>}</div>}
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
          const joinedBefore = selected && index > 0 && selection.selectedIds.has(conversation.messages[index - 1].id)
          const joinedAfter = selected && index < conversation.messages.length - 1 && selection.selectedIds.has(conversation.messages[index + 1].id)
          return <li key={message.id} data-message-id={message.id}
          ref={start ? firstSource : undefined}
          role={selectionMode ? 'option' : undefined} aria-selected={selectionMode ? selected : undefined} aria-label={`${message.senderName}：${message.text || messageKinds[message.kind]}`}
          tabIndex={selectionMode && tabStopId === message.id ? 0 : -1} {...(selectionMode ? selection.bindings(message) : {})} onFocus={() => setFocusedMessageId(message.id)}
          className={clsx('message', message.isSelf && 'message-self', highlighted && 'message-source', selected && 'message-selected',
            joinedBefore && 'selection-joined-before', joinedAfter && 'selection-joined-after', jumpId === message.id && 'message-reference-target')}>
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
      <ReaderDialog busy={selfSaving} onDismiss={() => setSelfModalOpen(false)} returnFocus={moreButton} labelledBy="self-modal-title">
      <div className="reader-modal-overlay" role="presentation" onClick={e => { if (e.target === e.currentTarget && !selfSaving) setSelfModalOpen(false) }}>
        <div className="reader-modal-card">
          <h2 id="self-modal-title">选择本人</h2>
          <p className="reader-modal-description">选择该会话中代表本人的发言成员。设置后，该成员的消息将作为本人发言靠右展示。</p>
          {selfError && <p className="import-error" role="alert">{selfError}</p>}
          <div className="reader-modal-body" role="radiogroup" aria-label="成员列表">
            {selfLoading ? <p className="reader-modal-empty">正在读取成员…</p> : !members.length ? <p className="reader-modal-empty">该会话暂无成员。</p> : (
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
              onClick={() => setSelfModalOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="reader-modal-btn reader-modal-btn-primary"
              disabled={selfSaving || !selectedMemberId || selectedMemberId === members.find(m => m.confirmedSelf)?.id}
              onClick={() => { void handleConfirmSelf(selectedMemberId) }}
            >
              {selfSaving ? '正在保存…' : '设为本人'}
            </button>
          </div>
        </div>
      </div>
      </ReaderDialog>
    )}
    {deleteModalOpen && (
      <ReaderDialog busy={deleteSaving} onDismiss={() => setDeleteModalOpen(false)} returnFocus={moreButton} labelledBy="delete-modal-title">
      <div className="reader-modal-overlay" role="presentation" onClick={e => { if (e.target === e.currentTarget && !deleteSaving) setDeleteModalOpen(false) }}>
        <div className="reader-modal-card">
          <h2 id="delete-modal-title">删除会话</h2>
          <p className="reader-modal-description">将彻底删除该会话及其全部聊天记录、成员、本人设置、对话记录与分析报告。此操作无法撤销。</p>
          {deleteError && <p className="import-error" role="alert">{deleteError}</p>}
          <div className="reader-modal-footer">
            <button
              type="button"
              className="reader-modal-btn"
              disabled={deleteSaving}
              onClick={() => setDeleteModalOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="reader-modal-btn reader-modal-btn-danger"
              disabled={deleteSaving}
              onClick={() => { void handleDelete() }}
            >
              {deleteSaving ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </div>
      </div>
      </ReaderDialog>
    )}
  </section>}
  </ConversationWorkspace>
}
