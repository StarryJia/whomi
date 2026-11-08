import React from 'react'

import MessagePartsRenderer from '../blocks/MessagePartsRenderer'
import type { MessageListItem } from '../types'

interface Props {
  message: MessageListItem
}

const MessageContent: React.FC<Props> = ({ message }) => {
  return (
    <>
      <MessagePartsRenderer message={message} />
      {message.role === 'user' && message.references}
    </>
  )
}

export default React.memo(MessageContent)
