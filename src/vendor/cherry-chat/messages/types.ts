import type { ReactNode } from 'react'
import type { ModelOption } from '../../../components/conversation-ai/model-selector'
import type { GenerationUsage } from '../../../components/conversation-ai/types'

export type MessageStatus = 'running' | 'done' | 'failed' | 'stopped'
export type CherryMessagePart = { type: 'text'; text: string }

export interface MessageListItem {
  id: string
  parentId?: string
  role: 'user' | 'assistant'
  status: MessageStatus
  model?: ModelOption
  stats?: GenerationUsage
  error?: string
  retryId?: string | number
  references?: ReactNode
}

export interface CherryUIMessage extends MessageListItem {
  parts: CherryMessagePart[]
}

export interface MessageStreamingLayers {
  historyPartsByMessageId: Record<string, CherryMessagePart[]>
  liveMessageIds: readonly string[]
}

export interface MessageListState {
  topic: { id: string }
  messages: MessageListItem[]
  partsByMessageId: Record<string, CherryMessagePart[]>
  streamingLayers: MessageStreamingLayers
  beforeList?: ReactNode
  estimateSize?: number
  overscan?: number
}

export interface MessageListActions {
  copyText(text: string): Promise<void>
  retryMessage(turnId: string | number): void
}

export interface MessageListProviderValue {
  state: MessageListState
  actions: MessageListActions
}
