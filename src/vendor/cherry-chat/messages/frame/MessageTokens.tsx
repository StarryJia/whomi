import { type FC, useId, useRef, useState } from 'react'

import { HoverCard, HoverCardContent, HoverCardTrigger, usePortalContainer } from '@cherrystudio/ui'

import { messagePerformance } from '../../../../components/conversation-ai/message-performance'
import type { MessageListItem } from '../types'
import MessageTokenDetailsCard from './MessageTokenDetailsCard'

interface MessageTokensProps {
  message: MessageListItem
}

function AssistantMessageTokens({ label, message }: { label: string; message: MessageListItem }) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)
  const [isDetailsPinned, setIsDetailsPinned] = useState(false)
  const contentId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const hoverDismissed = useRef(false)
  const portalContainer = usePortalContainer()
  const isDetailsVisible = isDetailsOpen || isDetailsPinned

  const dismiss = () => {
    hoverDismissed.current = true
    setIsDetailsOpen(false)
    setIsDetailsPinned(false)
  }
  const allowHover = () => { hoverDismissed.current = false }

  return (
    <HoverCard
      open={isDetailsVisible}
      onOpenChange={(open) => { if (!open || !hoverDismissed.current) setIsDetailsOpen(open) }}
      openDelay={200}
      closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-expanded={isDetailsVisible}
          aria-controls={isDetailsVisible ? contentId : undefined}
          className="message-tokens ml-auto cursor-pointer select-text border-0 bg-transparent text-right text-xs text-muted-foreground tabular-nums leading-5 transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:underline"
          onPointerEnter={allowHover}
          onFocus={allowHover}
          onClick={() => {
            if (isDetailsPinned) dismiss()
            else {
              allowHover()
              setIsDetailsPinned(true)
            }
          }}>
          {label}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        id={contentId}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        collisionBoundary={portalContainer?.parentElement ?? undefined}
        className="cherry-message-token-popover w-[28rem] max-w-(--radix-hover-card-content-available-width) p-0"
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (isDetailsPinned) trigger.current?.focus({ preventScroll: true })
          dismiss()
        }}
        onPointerDownOutside={(event) => {
          if (event.target instanceof Node && trigger.current?.contains(event.target)) return
          dismiss()
        }}>
        <MessageTokenDetailsCard message={message} />
      </HoverCardContent>
    </HoverCard>
  )
}

const decimalFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const numberFormatter = new Intl.NumberFormat('zh-CN')

function knownMetric(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

const MessageTokens: FC<MessageTokensProps> = ({ message }) => {
  const stats = message.stats
  if (!stats || message.role !== 'assistant') return null

  const { inputTokens, modelTokensPerSecond } = messagePerformance(stats)
  if (![inputTokens, stats.outputTokens, stats.durationMs, stats.firstTokenMs, stats.cacheReadTokens, stats.cacheWriteTokens]
    .some(knownMetric)) return null

  const tokenLabel = knownMetric(stats.outputTokens) ? `输出 ${numberFormatter.format(stats.outputTokens)} token` : '生成统计'
  const throughputLabel = knownMetric(modelTokensPerSecond) ? `${decimalFormatter.format(modelTokensPerSecond)} token/秒` : undefined
  const label = throughputLabel ? `${tokenLabel} · ${throughputLabel}` : tokenLabel
  return <AssistantMessageTokens label={label} message={message} />
}

export default MessageTokens
