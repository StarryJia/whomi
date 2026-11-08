import { MessageCircle } from 'lucide-react'
import { createContext, type ReactNode, type Ref, use, useImperativeHandle, useMemo, useRef, useState } from 'react'

import { PortalContainerProvider } from '@cherrystudio/ui'

import MessageList from '../../../vendor/cherry-chat/messages/MessageList'
import { MessageListProvider } from '../../../vendor/cherry-chat/messages/MessageListProvider'
import type { MessageVirtualListHandle } from '../../../vendor/cherry-chat/messages/list/MessageVirtualList'
import { useMessageStreamingLayers } from '../../../vendor/cherry-chat/messages/stream/useMessageStreamingLayers'
import type {
  CherryMessagePart, CherryUIMessage, MessageListActions, MessageListItem, MessageStatus
} from '../../../vendor/cherry-chat/messages/types'
import type { ModelOption } from '../model-selector'
import type { ConversationRequest, GenerationUsage } from '../types'
import '../../../vendor/cherry-chat/messages/messages.css'

export interface CherryMessageTurn {
  id: string | number
  request: ConversationRequest
  modelIdentity?: ModelOption
  referenceIds?: string[]
  text: string
  usage?: GenerationUsage
  status: MessageStatus
  error?: string
  remote?: boolean
}

export interface CherryMessagesHandle {
  scrollToBottom(): void
}

interface CherryMessagesProps {
  turns: readonly CherryMessageTurn[]
  scopeKey: string
  running: boolean
  onRetry(turnId: string | number): void
  renderReferences(turn: CherryMessageTurn): ReactNode
  active?: boolean
  loading?: boolean
  error?: string
  ref?: Ref<CherryMessagesHandle>
}

const ReferencesContext = createContext<{
  turnsByUserId: Map<string, CherryMessageTurn>
  renderReferences: CherryMessagesProps['renderReferences']
} | null>(null)

function MessageReferences({ messageId }: { messageId: string }) {
  const source = use(ReferencesContext)
  const turn = source?.turnsByUserId.get(messageId)
  return turn && source ? source.renderReferences(turn) : null
}

function sameFields<T extends object>(previous: T | undefined, next: T | undefined): boolean {
  if (previous === next) return true
  if (!previous || !next) return false
  const keys = Object.keys(previous) as (keyof T)[]
  return keys.length === Object.keys(next).length && keys.every((key) =>
    Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
}

const EMPTY_PARTS: CherryMessagePart[] = []

function useMessageProjection(turns: readonly CherryMessageTurn[], running: boolean) {
  const previousRows = useRef(new Map<string, MessageListItem>())
  return useMemo(() => {
    const messages: MessageListItem[] = []
    const baseMessages: CherryUIMessage[] = []
    const overlay: Record<string, CherryMessagePart[]> = {}
    const liveAssistants: string[] = []
    const nextRows = new Map<string, MessageListItem>()
    const turnsByUserId = new Map<string, CherryMessageTurn>()

    function addMessage(message: MessageListItem, parts: CherryMessagePart[]) {
      messages.push(message)
      baseMessages.push({ ...message, parts })
      nextRows.set(message.id, message)
    }

    for (const [index, turn] of turns.entries()) {
      // The request identity survives the optimistic row being replaced by a stored turn.
      const turnKey = turn.request.requestId ?? String(turn.id)
      const userId = `${turnKey}:user`
      const assistantId = `${turnKey}:assistant`
      const isLive = turn.status === 'running'
      const retryId = !running && index === turns.length - 1 && (turn.status === 'failed' || turn.status === 'stopped')
        ? turn.id : undefined

      const user = previousRows.current.get(userId) ?? {
        id: userId, role: 'user', status: 'done', references: <MessageReferences messageId={userId} />
      }
      turnsByUserId.set(userId, turn)
      addMessage(user, [{ type: 'text', text: turn.request.prompt }])

      const previous = previousRows.current.get(assistantId)
      const assistant = previous && previous.status === turn.status && previous.error === turn.error &&
        previous.retryId === retryId && sameFields(previous.model, turn.modelIdentity) && sameFields(previous.stats, turn.usage)
        ? previous
        : { id: assistantId, parentId: userId, role: 'assistant' as const, status: turn.status, retryId,
            model: turn.modelIdentity, stats: turn.usage, error: turn.error }
      const textParts: CherryMessagePart[] = turn.text ? [{ type: 'text', text: turn.text }] : EMPTY_PARTS
      addMessage(assistant, isLive ? EMPTY_PARTS : textParts)

      if (isLive) {
        overlay[assistantId] = textParts
        liveAssistants.push(assistantId)
      }
    }

    previousRows.current = nextRows
    return { messages, baseMessages, overlay, liveAssistants, turnsByUserId }
  }, [running, turns])
}

function ThreadMessages({ turns, scopeKey, running, onRetry, renderReferences, loading, error, ref }: CherryMessagesProps) {
  const { messages, baseMessages, overlay, liveAssistants, turnsByUserId } = useMessageProjection(turns, running)
  const { partsByMessageId, streamingLayers } = useMessageStreamingLayers({ messages: baseMessages, overlay, liveAssistants })
  const topic = useMemo(() => ({ id: scopeKey }), [scopeKey])
  const retry = useRef(onRetry)
  retry.current = onRetry
  const actions = useMemo<MessageListActions>(() => ({
    copyText: text => navigator.clipboard.writeText(text),
    retryMessage: turnId => retry.current(turnId)
  }), [])
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  const list = useRef<MessageVirtualListHandle>(null)
  useImperativeHandle(ref, () => ({ scrollToBottom: () => list.current?.scrollToBottom() }), [])

  const beforeList = loading || error ? (
    <div className="px-6 pt-3">
      {loading && <p role="status" className="conversation-state-copy">正在恢复对话…</p>}
      {error && <p role="alert" className="conversation-error">{error}</p>}
    </div>
  ) : null

  return (
    <div className="cherry-chat-surface cherry-messages flex min-h-0 min-w-0 flex-1 flex-col"
      role="log" aria-label="AI 对话记录" aria-live="polite">
      {messages.length === 0 ? (
        beforeList ?? (
          <div className="conversation-chat-empty flex-1">
            <MessageCircle aria-hidden="true" /><strong>你想从这段聊天里了解什么？</strong>
            <p>直接写下问题，或从原文选择想讨论的消息。</p>
          </div>
        )
      ) : (
        <PortalContainerProvider container={portalContainer}>
          <ReferencesContext value={{ turnsByUserId, renderReferences }}>
            <MessageListProvider value={{ actions, state: { topic, messages, partsByMessageId, streamingLayers,
              estimateSize: 160, beforeList } }}>
              <MessageList handleRef={list} />
            </MessageListProvider>
          </ReferencesContext>
        </PortalContainerProvider>
      )}
      <div ref={setPortalContainer} className="shrink-0" />
    </div>
  )
}

export function CherryMessages(props: CherryMessagesProps) {
  return props.active === false ? null : <ThreadMessages key={props.scopeKey} {...props} />
}
