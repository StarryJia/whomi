import { Check, Copy, RotateCcw } from 'lucide-react'

import { createActionRegistry } from '../actions/actionRegistry'
import type { ActionAvailabilityInput, ActionDescriptor, ResolvedAction } from '../actions/actionTypes'
import type { MessageListActions, MessageListItem } from '../types'

export interface MessageMenuBarActionContext {
  actions: MessageListActions
  message: MessageListItem
  mainTextContent: string
  copied: boolean
  setCopied(copied: boolean): void
  isCopying: boolean
  isProcessing: boolean
}

export type MessageMenuBarResolvedAction = ResolvedAction<MessageMenuBarActionContext>

const toolbarOrder = new Map(['copy', 'assistant-retry'].map((id, index) => [id, index * 10]))
const messageMenuBarActionRegistry = createActionRegistry<MessageMenuBarActionContext>()

function toolbarAvailability(isVisible: (context: MessageMenuBarActionContext) => boolean) {
  return (context: MessageMenuBarActionContext): ActionAvailabilityInput => {
    const visible = isVisible(context)
    return { visible, enabled: visible && !context.isProcessing }
  }
}

function registerCommand(id: string, run: (context: MessageMenuBarActionContext) => void | Promise<void>) {
  messageMenuBarActionRegistry.registerCommand({ id, run })
}

function registerToolbarAction(descriptor: Omit<ActionDescriptor<MessageMenuBarActionContext>, 'order' | 'surface'>) {
  messageMenuBarActionRegistry.registerAction({
    ...descriptor,
    order: toolbarOrder.get(descriptor.id) ?? 0,
    surface: 'toolbar'
  })
}

registerCommand('message.copy', async ({ actions, mainTextContent, setCopied }) => {
  await actions.copyText(mainTextContent)
  setCopied(true)
})

registerCommand('message.retry', ({ actions, message }) => {
  if (message.retryId !== undefined) actions.retryMessage(message.retryId)
})

registerToolbarAction({
  id: 'copy',
  commandId: 'message.copy',
  label: ({ copied }) => copied ? '已复制' : '复制回答',
  icon: ({ copied }) => copied ? <Check size={15} color="var(--primary)" aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />,
  availability: ({ message, mainTextContent, isProcessing, isCopying }) => {
    const visible = message.role === 'assistant' && Boolean(mainTextContent.trim())
    return { visible, enabled: visible && !isProcessing && !isCopying }
  }
})

registerToolbarAction({
  id: 'assistant-retry',
  commandId: 'message.retry',
  label: '重试回答',
  icon: <RotateCcw size={15} aria-hidden="true" />,
  availability: toolbarAvailability(({ message }) =>
    message.role === 'assistant' && message.retryId !== undefined &&
    (message.status === 'stopped' || message.status === 'failed'))
})

export function resolveMessageMenuBarToolbarActions(context: MessageMenuBarActionContext): MessageMenuBarResolvedAction[] {
  return messageMenuBarActionRegistry.resolve(context, 'toolbar')
}

export function executeMessageMenuBarAction(actionId: string, context: MessageMenuBarActionContext): Promise<boolean> {
  return messageMenuBarActionRegistry.execute(actionId, context)
}
