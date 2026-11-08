import { UserRound } from 'lucide-react'
import type { ReactNode } from 'react'

import { MessageAvatarFrame } from './MessageAvatar'

/** User content geometry shared by submitted messages and transient attachments. */
export function MessageUserLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full justify-end">
      <div className="flex max-w-[calc(100%-2.5rem)] min-w-0 items-start justify-end gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col items-end">{children}</div>
        <MessageAvatarFrame className="mt-1.5 bg-muted text-muted-foreground" aria-hidden="true">
          <UserRound size={17} />
        </MessageAvatarFrame>
      </div>
    </div>
  )
}
