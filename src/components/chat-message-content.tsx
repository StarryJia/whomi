import type { MessageView } from '../shared/desktop-api'

export function ConversationAvatar({ name }: { name: string }) {
  return <span className="conversation-avatar" aria-hidden="true">{[...name.trim()][0] || '·'}</span>
}

const dayFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

function messageDate(message: MessageView) {
  if (message.timeBucket === 1 || message.sentAtMs === null) return null
  const date = new Date(message.sentAtMs)
  return Number.isNaN(date.getTime()) ? null : date
}

export function messageDay(message: MessageView) {
  const date = messageDate(message)
  return date ? dayFormat.format(date) : '时间未知'
}

function ReplyQuote({ reply, target, onOpen, busy }: {
  reply: NonNullable<MessageView['reply']>
  target?: MessageView
  onOpen?: (targetId: string) => void
  busy?: boolean
}) {
  const sender = reply.senderName ?? target?.senderName
  const text = reply.text ?? target?.text ?? '原消息'
  const content = <>{sender && <strong>{sender}</strong>}<span>{text}</span></>
  const targetId = reply.targetMessageId
  if (reply.state !== 'resolved' || !targetId || !onOpen) {
    return <blockquote className="message-quote" title={text}>{content}</blockquote>
  }
  return <button className="message-quote is-linked" type="button" disabled={busy}
    aria-label={`查看引用原消息：${sender ? `${sender}：` : ''}${text.slice(0, 120)}`} title={text}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onOpen(targetId) }}>{content}</button>
}

export function ChatMessageContent({ message, groupedByDate, firstUnknownTime, sourceLabel, replyTarget, onOpenReply, replyBusy }: {
  message: MessageView
  groupedByDate?: boolean
  firstUnknownTime?: boolean
  sourceLabel?: string
  replyTarget?: MessageView
  onOpenReply?: (targetId: string) => void
  replyBusy?: boolean
}) {
  const date = messageDate(message)
  const time = date ? (groupedByDate ? clockFormat.format(date) : date.toLocaleString('zh-CN')) : message.timeRaw
  if (message.kind === 'system') return <div className="message-notice">
    {firstUnknownTime && <span>时间未知</span>}
    {time && <span>{time}</span>}
    <p className="message-notice-text">{message.text || '系统消息'}</p>
    {sourceLabel && <span className="source-range-label">{sourceLabel}</span>}
  </div>
  return <>
    <ConversationAvatar name={message.senderName} />
    <div className="message-content">
      {firstUnknownTime && <p className="message-time-unknown">时间未知</p>}
      <div className="message-meta">
        <span>{message.senderName}</span>
        {time && <span>{time}</span>}
        {sourceLabel && <span className="source-range-label">{sourceLabel}</span>}
      </div>
      <p className="message-text">{message.text}</p>
      {message.reply && <ReplyQuote reply={message.reply} target={replyTarget} onOpen={onOpenReply} busy={replyBusy} />}
    </div>
  </>
}
