import type { MessageView } from '../../shared/desktop-api'
import { Fragment } from 'react'

function time(message: MessageView) {
  return message.sentAtMs === null ? message.timeRaw : new Date(message.sentAtMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
const date = (message: MessageView) => message.sentAtMs === null ? '时间未知' : new Date(message.sentAtMs).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

export function ReadOnlyMessages({ messages, highlightIds }: { messages: readonly MessageView[]; highlightIds: readonly string[] }) {
  const evidence = new Set(highlightIds)
  return <ol className="message-list" aria-label="原文消息">{messages.map((message, index) => <Fragment key={message.id}>
    {(index === 0 || date(messages[index - 1]) !== date(message)) && <li className="insight-message-date" role="presentation">{date(message)}</li>}
    <li data-message-id={message.id}
    data-citation={evidence.has(message.id)} className={['message', message.isSelf && 'message-self', evidence.has(message.id) && 'message-source'].filter(Boolean).join(' ')}>
    <span className="conversation-avatar" aria-hidden="true">{[...message.senderName.trim()][0] || '·'}</span>
    <div className="message-content"><div className="message-meta"><span>{message.senderName}</span><span>{time(message) || '时间未知'}</span></div>
      <p className="message-text">{message.text}</p>
      {message.reply && <blockquote className="message-quote">{message.reply.senderName && <strong>{message.reply.senderName}</strong>}<span>{message.reply.text ?? '原消息'}</span></blockquote>}
    </div>
  </li></Fragment>)}</ol>
}
