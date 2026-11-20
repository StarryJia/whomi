import { Fragment } from 'react'
import type { MessageView } from '../../shared/desktop-api'
import { ChatMessageContent, messageDay } from '../chat-message-content'

export function ReadOnlyMessages({ messages, highlightIds }: { messages: readonly MessageView[]; highlightIds: readonly string[] }) {
  const evidence = new Set(highlightIds)
  const byId = new Map(messages.map(message => [message.id, message]))
  let previousDay: string | undefined
  return <ol className="message-list" aria-label="原文消息">{messages.map(message => {
    const day = messageDay(message)
    const startsDay = day !== previousDay
    previousDay = day
    const highlighted = evidence.has(message.id)
    const replyId = message.reply?.targetMessageId
    return <Fragment key={message.id}>
      {startsDay && <li className="insight-message-date" role="presentation">{day}</li>}
      <li data-message-id={message.id} data-citation={highlighted}
        className={['message', message.isSelf && 'message-self', highlighted && 'message-source'].filter(Boolean).join(' ')}>
        <ChatMessageContent message={message} groupedByDate replyTarget={replyId ? byId.get(replyId) : undefined} />
      </li>
    </Fragment>
  })}</ol>
}
