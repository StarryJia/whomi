import { MessageCircle } from 'lucide-react'
import { type ReactNode, memo } from 'react'

import type { MessageListItem } from '../types'
import { MessageAvatarFrame } from './MessageAvatar'

interface Props {
  message: MessageListItem
  contentSlot?: ReactNode
  footerSlot?: ReactNode
}

const MessageHeader = memo(({ message, contentSlot, footerSlot }: Props) => {
  const displayModel = message.model
  const username = displayModel?.label ?? '未知模型'
  const hasBodySlot = !!contentSlot || !!footerSlot

  return (
    <div
      className={`message-header group/header relative flex gap-2.5 ${hasBodySlot ? 'mb-0 items-start' : 'mb-2 items-center'}`}>
      <MessageAvatarFrame className="bg-muted text-muted-foreground" aria-hidden="true">
        <MessageCircle size={17} />
      </MessageAvatarFrame>
      <div className={hasBodySlot ? 'message-body-column flex min-h-0 min-w-0 flex-1 flex-col' : 'flex min-w-0 flex-1'}>
        <div className="flex w-full min-w-0 items-center gap-1.5">
          <span
            className="truncate font-semibold text-sm leading-5 text-foreground"
            title={[username, displayModel?.model].filter(Boolean).join(' | ')}>
            {username}
          </span>
        </div>
        {contentSlot && (
          <div className="message-body-content mt-2 min-h-0 min-w-0 max-w-full flex-1">{contentSlot}</div>
        )}
        {footerSlot && <div className="message-footer-slot mt-auto min-w-0 shrink-0">{footerSlot}</div>}
      </div>
    </div>
  )
})

export default MessageHeader
