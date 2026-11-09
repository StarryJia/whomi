/**
 * Shared assembly of the streaming projection consumed by `MessageList`:
 * stable part layers (via {@link useStableMessagePartsLayers}), the live
 * message-id set, and the `streamingLayers` contract object. Home and Agent
 * runtime-state hooks both derive their list inputs through this hook so the
 * two surfaces cannot drift.
 */

import { useMemo, useRef } from 'react'

import type { CherryMessagePart, CherryUIMessage, MessageStreamingLayers } from '../types'
import { useStableMessagePartsLayers } from './useStableMessagePartsLayers'

interface MessageStreamingLayersParams {
  messages: CherryUIMessage[]
  /** messageId -> latest streamed parts from the execution overlay. */
  overlay: Record<string, CherryMessagePart[]>
  /** Latest assistant snapshot per execution. */
  liveAssistants: readonly string[]
}

interface MessageStreamingLayersResult {
  partsByMessageId: Record<string, CherryMessagePart[]>
  liveMessageIds: readonly string[]
  streamingLayers: MessageStreamingLayers
}

export function useMessageStreamingLayers({
  messages,
  overlay,
  liveAssistants
}: MessageStreamingLayersParams): MessageStreamingLayersResult {
  const { historyPartsByMessageId, partsByMessageId } = useStableMessagePartsLayers(messages, overlay)
  const stableLiveIds = useRef(liveAssistants)
  const previous = stableLiveIds.current
  if (previous.length !== liveAssistants.length || previous.some((id, index) => id !== liveAssistants[index])) {
    stableLiveIds.current = liveAssistants
  }
  const liveMessageIds = stableLiveIds.current
  const streamingLayers = useMemo<MessageStreamingLayers>(
    () => ({ historyPartsByMessageId, liveMessageIds }),
    [historyPartsByMessageId, liveMessageIds]
  )

  return { partsByMessageId, liveMessageIds, streamingLayers }
}
