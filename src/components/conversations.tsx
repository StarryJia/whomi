import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Ellipsis, Plus } from 'lucide-react'
import clsx from 'clsx'
import { Tooltip } from './ui/tooltip'
import type { SourceReference } from './overview/types'

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

export function ConversationNavigation({ wide, conversations, activeId, onSelect, onImport }: {
  wide: boolean
  conversations: readonly Conversation[]
  activeId?: string
  onSelect: (id: string) => void
  onImport: () => void
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
        </div>
      </div>
    </section>
  )
}

export function ConversationReader({ conversation, sourceRange, onReturn, returnLabel = '返回个人总览' }: {
  conversation: Conversation
  sourceRange?: { messageId: string; endMessageId?: string }
  onReturn?: () => void
  returnLabel?: string
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const firstSource = useRef<HTMLLIElement>(null)
  const range = sourceRange ? resolveSourceRange([conversation], {
    id: 'reader', conversationId: conversation.id, ...sourceRange, title: '', context: '',
  }) : null
  useLayoutEffect(() => {
    if (firstSource.current) {
      firstSource.current.focus({ preventScroll: true })
      firstSource.current.scrollIntoView?.({ block: 'center', behavior: 'auto' })
    } else heading.current?.focus()
  }, [conversation.id, sourceRange?.messageId, sourceRange?.endMessageId])
  return <section className="conversation-reader" aria-labelledby="conversation-title">
    <header className="reader-header">
      {onReturn && <button className="reader-return" type="button" onClick={onReturn}>
        <ArrowLeft aria-hidden="true" />{returnLabel}
      </button>}
      <h1 id="conversation-title" ref={heading} tabIndex={-1}>{conversation.title}</h1>
      {sourceRange && <p className="reader-source-note" role="status">{range
        ? '已定位相关交流，可继续阅读前后文。'
        : '无法定位原文，请在这段会话中查找。'}</p>}
    </header>
    <div className="reader-scroll" role="region" aria-label="聊天记录" tabIndex={0}>
      {conversation.messages.length ? <ol className="message-list">
        {conversation.messages.map((message, index) => <li key={message.id}
          ref={range?.startIndex === index ? firstSource : undefined}
          tabIndex={range?.startIndex === index ? -1 : undefined}
          className={clsx('message', message.isSelf && 'message-self', range && index >= range.startIndex && index <= range.endIndex && 'message-source')}>
          <Initial name={message.sender} />
          <div className="message-content">
            <div className="message-meta"><span>{message.sender}</span>{message.time && <span>{message.time}</span>}{range?.startIndex === index && <span className="source-range-label">引用范围起点</span>}{range?.endIndex === index && range.endIndex !== range.startIndex && <span className="source-range-label">引用范围终点</span>}</div>
            <p className="message-text">{message.text}</p>
          </div>
        </li>)}
      </ol> : <p className="reader-empty">这段会话还没有聊天记录。</p>}
    </div>
  </section>
}
