/**
 * Keep history independent from live text updates. Reuse unchanged part arrays
 * so streaming one answer does not invalidate settled message descendants.
 */

import { useMemo, useRef } from 'react'

import type { CherryMessagePart, CherryUIMessage } from '../types'

export interface StableMessagePartsLayers {
  historyPartsByMessageId: Record<string, CherryMessagePart[]>
  partsByMessageId: Record<string, CherryMessagePart[]>
}

interface StableMessagePartsLayersCache {
  messageCount: number
  value: StableMessagePartsLayers
}

function partsContentEqual(a: CherryMessagePart[], b: CherryMessagePart[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const previousPart = a[i]
    const nextPart = b[i]
    if (previousPart === nextPart) continue
    if (previousPart.type !== nextPart.type || previousPart.text !== nextPart.text) return false
  }
  return true
}

export function useStableMessagePartsLayers(
  messages: CherryUIMessage[],
  overlay: Record<string, CherryMessagePart[]>
): StableMessagePartsLayers {
  const cacheRef = useRef<StableMessagePartsLayersCache>({
    messageCount: 0,
    value: {
      historyPartsByMessageId: {},
      partsByMessageId: {}
    }
  })

  return useMemo(() => {
    const previous = cacheRef.current
    const previousHistory = previous.value.historyPartsByMessageId
    const previousCurrent = previous.value.partsByMessageId
    const nextHistory: Record<string, CherryMessagePart[]> = {}
    const nextCurrent: Record<string, CherryMessagePart[]> = {}
    let historyChanged = previous.messageCount !== messages.length
    let currentChanged = previous.messageCount !== messages.length
    let hasExecutionOverlay = false

    for (const message of messages) {
      const baseParts = (message.parts ?? []) as CherryMessagePart[]
      const previousHistoryParts = previousHistory[message.id]
      const historyParts =
        previousHistoryParts && partsContentEqual(previousHistoryParts, baseParts) ? previousHistoryParts : baseParts
      nextHistory[message.id] = historyParts
      historyChanged ||= historyParts !== previousHistoryParts

      const executionParts = overlay[message.id]
      const usesExecutionOverlay = executionParts !== undefined && executionParts.length > 0
      hasExecutionOverlay ||= usesExecutionOverlay
      const currentCandidate = usesExecutionOverlay ? executionParts : historyParts
      const previousCurrentParts = previousCurrent[message.id]
      const currentParts =
        previousCurrentParts && partsContentEqual(previousCurrentParts, currentCandidate)
          ? previousCurrentParts
          : currentCandidate
      nextCurrent[message.id] = currentParts
      currentChanged ||= currentParts !== previousCurrentParts
    }

    for (const [messageId, executionParts] of Object.entries(overlay)) {
      if (messageId in nextCurrent || executionParts.length === 0) continue
      hasExecutionOverlay = true
      const previousCurrentParts = previousCurrent[messageId]
      const currentParts =
        previousCurrentParts && partsContentEqual(previousCurrentParts, executionParts)
          ? previousCurrentParts
          : executionParts
      nextCurrent[messageId] = currentParts
      currentChanged ||= currentParts !== previousCurrentParts
    }

    if (!currentChanged) {
      for (const messageId in previousCurrent) {
        if (!(messageId in nextCurrent)) {
          currentChanged = true
          break
        }
      }
    }

    const historyPartsByMessageId = historyChanged ? nextHistory : previousHistory
    let partsByMessageId = previousCurrent
    if (!hasExecutionOverlay) {
      partsByMessageId = historyPartsByMessageId
    } else if (currentChanged) {
      partsByMessageId = nextCurrent
    }

    if (
      previous.messageCount === messages.length &&
      historyPartsByMessageId === previousHistory &&
      partsByMessageId === previousCurrent
    ) {
      return previous.value
    }

    const value = { historyPartsByMessageId, partsByMessageId }
    cacheRef.current = { messageCount: messages.length, value }
    return value
  }, [messages, overlay])
}

export function useStablePartsByMessageId(
  messages: CherryUIMessage[],
  overlay: Record<string, CherryMessagePart[]>
): Record<string, CherryMessagePart[]> {
  return useStableMessagePartsLayers(messages, overlay).partsByMessageId
}
