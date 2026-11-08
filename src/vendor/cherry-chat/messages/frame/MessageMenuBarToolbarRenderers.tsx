import { Tooltip } from '@cherrystudio/ui'

import { MessageActionButton } from './MessageActionButton'
import type { MessageMenuBarResolvedAction } from './messageMenuBarActions'

export function renderDefaultToolbarAction({
  action,
  executeAction,
  softHoverBg
}: {
  action: MessageMenuBarResolvedAction
  executeAction: (action: MessageMenuBarResolvedAction) => void | Promise<void>
  softHoverBg: boolean
}) {
  const disabled = !action.availability.enabled
  const label = typeof action.label === 'string' ? action.label : undefined

  return (
    <Tooltip content={action.label} delay={800}>
      <MessageActionButton
        className="message-action-button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation()
          void executeAction(action)
        }}
        disabled={disabled}
        softHoverBg={softHoverBg}>
        {action.icon}
      </MessageActionButton>
    </Tooltip>
  )
}
