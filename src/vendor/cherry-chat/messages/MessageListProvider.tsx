import type { Context, ReactNode } from 'react'
import { createContext, use, useMemo } from 'react'

import { PartsProvider } from './blocks/MessagePartsContext'
import type { MessageListActions, MessageListItem, MessageListProviderValue, MessageListState } from './types'

type MessageListDataValue = Pick<MessageListState, 'topic' | 'beforeList' | 'estimateSize' | 'overscan' | 'streamingLayers'>
type MessageListMessagesValue = MessageListItem[]

const MessageListDataContext = createContext<MessageListDataValue | null>(null)
const MessageListMessagesContext = createContext<MessageListMessagesValue | null>(null)
const MessageListActionsContext = createContext<MessageListActions | null>(null)

export const MessageListProvider = ({ value, children }: { value: MessageListProviderValue; children: ReactNode }) => {
  const { state, actions } = value
  const data = useMemo<MessageListDataValue>(
    () => ({
      topic: state.topic,
      beforeList: state.beforeList,
      estimateSize: state.estimateSize,
      overscan: state.overscan,
      streamingLayers: state.streamingLayers
    }),
    [state.topic, state.beforeList, state.estimateSize, state.overscan, state.streamingLayers]
  )

  return (
    <MessageListDataContext value={data}>
      <MessageListMessagesContext value={state.messages}>
        <PartsProvider value={state.partsByMessageId}>
          <MessageListActionsContext value={actions}>{children}</MessageListActionsContext>
        </PartsProvider>
      </MessageListMessagesContext>
    </MessageListDataContext>
  )
}

const useRequiredContext = <T,>(context: Context<T | null>, name: string): T => {
  const value = use(context)
  if (value === null) {
    throw new Error(`${name} must be used within MessageListProvider`)
  }
  return value
}

export const useMessageListData = () => {
  const data = useRequiredContext(MessageListDataContext, 'useMessageListData')
  const messages = useRequiredContext(MessageListMessagesContext, 'useMessageListData')
  return useMemo(() => ({ ...data, messages }), [data, messages])
}

export const useMessageListActions = (): MessageListActions => {
  return useRequiredContext(MessageListActionsContext, 'useMessageListActions')
}
