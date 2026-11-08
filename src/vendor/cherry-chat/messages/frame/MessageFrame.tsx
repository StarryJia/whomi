import { type FC, memo } from 'react'

import { cn } from '@cherrystudio/ui/lib/utils'

import { MessagePartsScopeProvider } from '../blocks/MessagePartsContext'
import type { CherryMessagePart, MessageListItem } from '../types'
import HorizontalScrollContainer from './HorizontalScrollContainer'
import MessageContent from './MessageContent'
import MessageErrorBoundary from './MessageErrorBoundary'
import MessageHeader from './MessageHeader'
import MessageMenuBar from './MessageMenuBar'
import { MessageUserLayout } from './MessageUserLayout'

interface Props {
  message: MessageListItem
  messageParts?: CherryMessagePart[]
  isLatestAssistantMessage?: boolean
}

const MessageItemContent: FC<Omit<Props, 'messageParts'>> = ({
  message,
  isLatestAssistantMessage = false
}) => {
  const isAssistantMessage = message.role === 'assistant'
  const isProcessing = message.status === 'running'
  const showAssistantFooterActions = isAssistantMessage && !isProcessing
  const assistantFooter = showAssistantFooterActions ? (
    <div
      className={cn(
        'MessageFooter mt-1 flex min-h-6.5 shrink-0 items-center justify-between gap-1.5 text-xs leading-none',
        !isLatestAssistantMessage && 'cherry-assistant-footer'
      )}>
      <HorizontalScrollContainer classNames={{ content: 'flex-1 flex-row items-center justify-between' }}>
        <MessageMenuBar message={message} isLastMessage={isLatestAssistantMessage} />
      </HorizontalScrollContainer>
    </div>
  ) : undefined

  const plainMessageContent = (
    <div data-ui="part:message-content" className="message-content-container mt-0 min-h-0 max-w-full pl-0">
      <MessageErrorBoundary>
        <MessageContent message={message} />
      </MessageErrorBoundary>
    </div>
  )

  return (
    <div
      key={message.id}
      className={cn(
        'message group/message relative flex w-full min-w-0 flex-col rounded-[10px] pt-2.5 pb-0',
        isAssistantMessage ? 'message-assistant' : 'message-user'
      )}>
      {!isAssistantMessage ? (
        <UserBubbleMessage message={message} />
      ) : (
        <MessageHeader message={message} contentSlot={plainMessageContent} footerSlot={assistantFooter} />
      )}
    </div>
  )
}

const MessageItem: FC<Props> = ({ message, messageParts, ...props }) => {
  const content = <MessageItemContent message={message} {...props} />
  if (!messageParts) return content

  return (
    <MessagePartsScopeProvider messageId={message.id} parts={messageParts}>
      {content}
    </MessagePartsScopeProvider>
  )
}

export default memo(MessageItem)

const UserBubbleMessage = ({ message }: { message: MessageListItem }) => (
  <div className="flex w-full flex-col items-end">
    <MessageUserLayout>
      <div
        data-ui="part:message-content"
        className="message-content-container mt-0 max-w-full rounded-[10px] bg-muted px-4 py-2.5 empty:hidden [&_.block-wrapper:last-child>*:last-child]:mb-0! [&_.markdown>p:last-child]:mb-0!">
        <MessageErrorBoundary>
          <MessageContent message={message} />
        </MessageErrorBoundary>
      </div>
    </MessageUserLayout>
  </div>
)
