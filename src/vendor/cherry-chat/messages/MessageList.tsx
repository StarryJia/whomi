import { type ComponentProps, memo, type Ref, useMemo, useRef } from 'react'

import NarrowLayout from '../shared/layout/NarrowLayout'
import { PartsProvider, usePartsMap } from './blocks/MessagePartsContext'
import MessageGroup from './list/MessageGroup'
import { MessageVirtualList, type MessageVirtualListHandle } from './list/MessageVirtualList'
import { useMessageListData } from './MessageListProvider'
import { getLatestAssistantGroupKey } from './utils/messageGroupKey'
import { createStableGroupedMessagesCache, stableGroupedMessages } from './utils/stableGroupedMessages'

type MessageGroupLayerProps = ComponentProps<typeof MessageGroup> & {
  groupKey: string
  isLive: boolean
}

function MessageGroupLayer({ groupKey, messages, partsByMessageId, isLatestAssistantGroup }: MessageGroupLayerProps) {
  return (
    <PartsProvider value={partsByMessageId ?? null}>
      <NarrowLayout narrowMode withSidePadding className="min-w-0">
        <MessageGroup
          key={groupKey}
          isLatestAssistantGroup={isLatestAssistantGroup}
          messages={messages}
          partsByMessageId={partsByMessageId}
        />
      </NarrowLayout>
    </PartsProvider>
  )
}

function groupPartsShallowEqual(
  previous: MessageGroupLayerProps['partsByMessageId'],
  next: MessageGroupLayerProps['partsByMessageId'],
  messages: MessageGroupLayerProps['messages']
): boolean {
  if (previous === next) return true
  return messages.every((message) => previous?.[message.id] === next?.[message.id])
}

const MessageLayer = memo(MessageGroupLayer, (previous, next) => {
  if (previous.isLive || next.isLive) return false
  return (
    previous.groupKey === next.groupKey &&
    previous.messages === next.messages &&
    groupPartsShallowEqual(previous.partsByMessageId, next.partsByMessageId, next.messages) &&
    previous.isLatestAssistantGroup === next.isLatestAssistantGroup
  )
})

interface MessageListProps {
  scrollPositionKey?: string
  handleRef?: Ref<MessageVirtualListHandle>
}

const MessageList = ({ scrollPositionKey, handleRef }: MessageListProps) => {
  const data = useMessageListData()
  const partsByMessageId = usePartsMap()
  const { topic, messages, beforeList } = data
  const groupedMessagesCacheRef = useRef(createStableGroupedMessagesCache())
  const groupedMessages = useMemo(() => stableGroupedMessages(messages, groupedMessagesCacheRef.current), [messages])
  const latestAssistantGroupKey = useMemo(() => getLatestAssistantGroupKey(messages), [messages])
  const streamingLayers = data.streamingLayers
  const liveMessageIds = streamingLayers.liveMessageIds
  const liveMessageIdSet = useMemo(() => new Set(liveMessageIds), [liveMessageIds])
  const firstLiveGroupIndex = useMemo(() => {
    if (liveMessageIds.length === 0) return groupedMessages.length
    const liveIndex = groupedMessages.findIndex(([, groupMessages]) =>
      groupMessages.some((message) => liveMessageIdSet.has(message.id))
    )
    return liveIndex >= 0 ? liveIndex : groupedMessages.length
  }, [groupedMessages, liveMessageIdSet, liveMessageIds.length])

  const keepMountedKeys = useMemo(() => {
    const keys = new Set<string>()
    if (liveMessageIds.length > 0 && latestAssistantGroupKey) keys.add(latestAssistantGroupKey)
    return [...keys]
  }, [latestAssistantGroupKey, liveMessageIds.length])

  return (
    <div className="messages-container flex min-h-0 min-w-0 flex-1 flex-col">
      {beforeList}
      <MessageVirtualList
        handleRef={handleRef}
        items={groupedMessages}
        getItemKey={(item) => item[0]}
        estimateSize={data.estimateSize}
        overscan={data.overscan}
        keepMountedKeys={keepMountedKeys}
        showScrollToBottomButton
        topicId={scrollPositionKey ?? topic.id}
        renderItem={([key, groupMessages], index) => (
          <MessageLayer
            groupKey={key}
            isLive={index >= firstLiveGroupIndex}
            isLatestAssistantGroup={key === latestAssistantGroupKey}
            messages={groupMessages}
            partsByMessageId={index < firstLiveGroupIndex ? streamingLayers.historyPartsByMessageId : partsByMessageId}
          />
        )}
        style={{ flex: 1, minHeight: 0 }}
      />
    </div>
  )
}

export default memo(MessageList)
