/**
 * Message parts contexts — extracted to avoid circular imports.
 *
 * PartsContext is the primary data source for message rendering.
 * Components read parts directly via useMessageParts / usePartsMap.
 */

import type { ReactNode } from 'react'
import { createContext, use, useMemo } from 'react'

import type { CherryMessagePart } from '../types'

/**
 * Parts context — provides raw CherryMessagePart[] keyed by message ID.
 * Null when no parts provider is present.
 */
export const PartsContext = createContext<Record<string, CherryMessagePart[]> | null>(null)

type PartsMap = Record<string, CherryMessagePart[]> | null
const EMPTY_MESSAGE_PARTS: CherryMessagePart[] = []
interface MessagePartsScopeValue {
  messageId: string
  parts: CherryMessagePart[]
}

const MessagePartsScopeContext = createContext<MessagePartsScopeValue | null>(null)

/**
 * Provide the complete parts map. A nested message scope takes precedence for
 * useMessageParts; resetting it here prevents an outer message scope leaking
 * into an intentionally isolated nested provider.
 */
export function PartsProvider({ value, children }: { value: PartsMap; children: ReactNode }) {
  return (
    <PartsContext value={value}>
      <MessagePartsScopeContext value={null}>{children}</MessagePartsScopeContext>
    </PartsContext>
  )
}

/** Provide one message's parts without subscribing its subtree to the complete map. */
export function MessagePartsScopeProvider({
  messageId,
  parts,
  children
}: {
  messageId: string
  parts: CherryMessagePart[]
  children: ReactNode
}) {
  const value = useMemo(() => ({ messageId, parts }), [messageId, parts])
  return <MessagePartsScopeContext value={value}>{children}</MessagePartsScopeContext>
}

/** Read the parts map from context (null when no provider is present). */
export function usePartsMap() {
  return use(PartsContext)
}

/**
 * Get raw parts for a message from PartsContext.
 * Returns empty array if no parts provider exists or no parts are present.
 */
export function useMessageParts(messageId: string): CherryMessagePart[] {
  const scope = use(MessagePartsScopeContext)
  if (scope?.messageId === messageId) return scope.parts

  // React's `use` API may be called conditionally. Scoped message consumers
  // therefore avoid subscribing to the complete map.
  const partsMap = use(PartsContext)
  return partsMap?.[messageId] ?? EMPTY_MESSAGE_PARTS
}
