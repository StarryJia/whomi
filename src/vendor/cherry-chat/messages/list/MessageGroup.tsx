import { type ComponentProps, memo } from 'react'

import MessageItem from '../frame/MessageFrame'
import type { CherryMessagePart, MessageListItem } from '../types'

const EMPTY_MESSAGE_PARTS: CherryMessagePart[] = []

interface MessageGroupProps {
  messages: MessageListItem[]
  partsByMessageId?: Record<string, CherryMessagePart[]> | null
  isLatestAssistantGroup?: boolean
}

const MessageGroup = ({ messages, partsByMessageId, isLatestAssistantGroup }: MessageGroupProps) => {
  const renderMessage = (message: MessageListItem) => {
    const messageProps = {
      isLatestAssistantMessage: isLatestAssistantGroup && message.role === 'assistant',
      message,
      messageParts: partsByMessageId ? (partsByMessageId[message.id] ?? EMPTY_MESSAGE_PARTS) : undefined
    } satisfies ComponentProps<typeof MessageItem>

    return (
      <MessageWrapper id={`message-${message.id}`} key={message.id} data-message-id={message.id}>
        <MessageItem {...messageProps} />
      </MessageWrapper>
    )
  }

  return (
    <GroupContainer id={messages[0].parentId ? `message-group-${messages[0].parentId}` : undefined}>
      <div className="flex min-w-0 flex-col">{messages.map(renderMessage)}</div>
    </GroupContainer>
  )
}

const GroupContainer = (props: ComponentProps<'div'>) => <div data-ui="chat.message.group" {...props} />

const MessageWrapper = (props: ComponentProps<'div'>) => <div className="min-w-0" {...props} />

function messageArrayShallowEqual(a: MessageListItem[], b: MessageListItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function messagePartsShallowEqual(
  previous: Record<string, CherryMessagePart[]> | null | undefined,
  next: Record<string, CherryMessagePart[]> | null | undefined,
  messages: MessageListItem[]
): boolean {
  if (previous === next) return true
  return messages.every((message) => previous?.[message.id] === next?.[message.id])
}

export default memo(MessageGroup, (prev, next) => {
  return (
    prev.isLatestAssistantGroup === next.isLatestAssistantGroup &&
    messageArrayShallowEqual(prev.messages, next.messages) &&
    messagePartsShallowEqual(prev.partsByMessageId, next.partsByMessageId, prev.messages)
  )
})
