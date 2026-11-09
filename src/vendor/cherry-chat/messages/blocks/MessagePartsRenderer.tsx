import React from 'react'

import type { CherryMessagePart, MessageListItem } from '../types'
import ErrorBlock from './ErrorBlock'
import MainTextBlock from './MainTextBlock'
import { useMessageParts } from './MessagePartsContext'
import PlaceholderBlock from './PlaceholderBlock'

function renderPart(part: CherryMessagePart, partId: string, message: MessageListItem) {
  switch (part.type) {
    case 'text':
      return <MainTextBlock id={partId} content={part.text} role={message.role} status={message.status} />
  }
}

const MessagePartsRendererContent = React.memo(function MessagePartsRendererContent({
  message, messageParts
}: {
  message: MessageListItem
  messageParts: CherryMessagePart[]
}) {
  const partEntries = messageParts.map((part, index) => ({ part, index })).filter(({ part }) => part.text.trim())
  if (partEntries.length === 0 && message.status === 'running') {
    return <PlaceholderBlock isProcessing />
  }

  return (
    <>
      {partEntries.map(({ part, index }) => {
        const partId = `${message.id}-part-${index}`
        return (
          <div key={partId} data-message-part-id={partId} className="block-wrapper text-foreground">
            {renderPart(part, partId, message)}
          </div>
        )
      })}
      {message.status === 'failed' && <ErrorBlock error={message.error} />}
      {message.status === 'stopped' && <p className="conversation-state-copy">已停止回答。</p>}
      {message.role === 'assistant' && message.status === 'done' && partEntries.length === 0 &&
        <p className="conversation-state-copy">回答为空，请重新提问。</p>}
    </>
  )
})

const MessagePartsRenderer = ({ message }: { message: MessageListItem }) => {
  const messageParts = useMessageParts(message.id)
  return <MessagePartsRendererContent message={message} messageParts={messageParts} />
}

export default React.memo(MessagePartsRenderer)
