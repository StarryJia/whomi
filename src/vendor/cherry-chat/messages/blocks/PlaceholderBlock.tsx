import { memo } from 'react'

const PlaceholderBlock = ({ isProcessing }: { isProcessing: boolean }) => {
  if (isProcessing) {
    return (
      <div
        role="status"
        className="flex min-h-7 flex-row items-center gap-1.5 py-0.5 text-[13px] leading-5 text-muted-foreground select-none"
        data-testid="message-status-placeholder">
        <span data-testid="message-status-text">正在回答…</span>
      </div>
    )
  }
  return null
}

export default memo(PlaceholderBlock)
