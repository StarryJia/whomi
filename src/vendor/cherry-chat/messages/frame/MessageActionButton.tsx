import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@cherrystudio/ui/lib/utils'

import ActionIconButton from './ActionIconButton'

type MessageActionButtonProps = Omit<ComponentProps<typeof ActionIconButton>, 'icon'> & {
  children?: ReactNode
  softHoverBg?: boolean
}

export const MessageActionButton = ({
  active,
  children,
  className,
  softHoverBg,
  type,
  ...props
}: MessageActionButtonProps) => {
  return (
    <ActionIconButton
      type={type ?? 'button'}
      active={active}
      icon={children}
      className={cn(
        'flex size-6.5 items-center justify-center rounded-md border-0 bg-transparent p-1 text-muted-foreground! transition-all duration-150 ease-out',
        "[&_svg:not([class*='size-'])]:!size-[15px] [&_.lucide]:text-current!",
        'enabled:cursor-pointer enabled:hover:text-foreground! disabled:cursor-not-allowed disabled:opacity-40',
        softHoverBg ? 'enabled:hover:bg-muted' : 'enabled:hover:bg-accent',
        active && 'text-primary!',
        className
      )}
      {...props}
    />
  )
}
