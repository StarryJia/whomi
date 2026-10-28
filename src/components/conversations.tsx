import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Ellipsis, Plus } from 'lucide-react'
import clsx from 'clsx'
import { Tooltip } from './ui/tooltip'

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
      <div className="conversation-toolbar">
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

export function ConversationReader({ conversation }: { conversation: Conversation }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { heading.current?.focus() }, [])
  return <section className="conversation-reader" aria-labelledby="conversation-title">
    <header className="reader-header">
      <h1 id="conversation-title" ref={heading} tabIndex={-1}>{conversation.title}</h1>
    </header>
    <div className="reader-scroll" role="region" aria-label="聊天记录" tabIndex={0}>
      {conversation.messages.length ? <ol className="message-list">
        {conversation.messages.map(message => <li key={message.id} className={clsx('message', message.isSelf && 'message-self')}>
          <Initial name={message.sender} />
          <div className="message-content">
            <div className="message-meta"><span>{message.sender}</span>{message.time && <span>{message.time}</span>}</div>
            <p className="message-text">{message.text}</p>
          </div>
        </li>)}
      </ol> : <p className="reader-empty">这段会话还没有聊天记录。</p>}
    </div>
  </section>
}
