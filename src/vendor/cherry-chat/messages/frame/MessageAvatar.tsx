import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '@cherrystudio/ui/lib/utils'

export const MESSAGE_AVATAR_CONTAINER_CLASS =
  'message-avatar flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-full p-0'

export const MessageAvatarFrame = ({ className, ...props }: ComponentPropsWithoutRef<'div'>) => (
  <div className={cn(MESSAGE_AVATAR_CONTAINER_CLASS, className)} {...props} />
)
