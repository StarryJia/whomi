import { Fragment } from 'react'
import type { MessageView } from '../../shared/desktop-api'
import { ChatMessageContent, messageDay } from '../chat-message-content'

export function ReadOnlyMessages({ messages, highlightIds, quote, replyTargetId, onOpenReply, replyBusy }: {
  messages: readonly MessageView[]; highlightIds: readonly string[]; quote?: string; replyTargetId?: string
  onOpenReply?: (targetId: string, originId: string) => void; replyBusy?: boolean
}) {
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
      <li data-message-id={message.id} data-citation={highlighted} tabIndex={-1}
        className={['message', message.isSelf && 'message-self', highlighted && 'message-source',
          message.id === replyTargetId && 'message-reference-target'].filter(Boolean).join(' ')}>
        <ChatMessageContent message={message} highlightText={highlighted ? quote : undefined}
          replyTarget={replyId ? byId.get(replyId) : undefined} replyBusy={replyBusy}
          onOpenReply={onOpenReply && (targetId => onOpenReply(targetId, message.id))} />
      </li>
    </Fragment>
  })}</ol>
}
