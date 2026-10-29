import type { Conversation } from '../components/conversations'
import type { MessagePage, MessageView } from '../shared/desktop-api'
import type { ConversationClient } from './use-conversations'

/** 仅适配明确标记为虚构的开发资料，不用于正式入口。 */
export function createPreviewClient(conversations: readonly Conversation[]): ConversationClient {
  const messages = new Map(conversations.map(conversation => [conversation.id, conversation.messages.map((message, index): MessageView => ({
    id: message.id, conversationId: conversation.id, memberId: null, senderKind: 'member', senderName: message.sender,
    isSelf: !!message.isSelf, sentAtMs: null, timeRaw: message.time ?? null, timePrecision: 'unknown', timezone: null,
    timeBucket: 1, sortTime: index, ordinal: index, kind: 'text', sourceType: null, text: message.text, reply: null, attachments: [],
  }))]))
  const summaries = conversations.map(conversation => ({ id: conversation.id, title: conversation.title, kind: 'unknown' as const,
    messageCount: conversation.messages.length, memberCount: new Set(conversation.messages.map(message => message.sender)).size,
    firstSentAtMs: null, lastSentAtMs: null, summaryStatus: 'ready' as const }))
  function page(id: string, start: number, limit: number, boundary?: number): MessagePage {
    const items = messages.get(id) ?? []
    const end = Math.min(start + limit, items.length, boundary ?? items.length)
    return { items: items.slice(start, end), beforeCursor: start > 0 ? `${start}:${limit}` : null,
      afterCursor: end < items.length ? `${end}:${limit}` : null, snapshotMaxId: '0' }
  }
  return {
    async listConversations({ cursor, limit = 100 }) {
      const start = Number(cursor ?? 0)
      return { items: summaries.slice(start, start + limit), nextCursor: start + limit < summaries.length ? String(start + limit) : null }
    },
    async readMessages({ conversationId, direction, cursor, limit = 100 }) {
      const [boundary, size] = cursor?.split(':').map(Number) ?? [direction === 'before' ? (messages.get(conversationId)?.length ?? 0) : 0, limit]
      return page(conversationId, direction === 'before' ? Math.max(0, boundary - size) : boundary, size, direction === 'before' ? boundary : undefined)
    },
    async locateSource({ conversationId, messageId, endMessageId }) {
      const items = messages.get(conversationId) ?? []
      const start = items.findIndex(message => message.id === messageId)
      const end = endMessageId ? items.findIndex(message => message.id === endMessageId) : start
      if (start < 0 || end < start) return { status: 'unavailable' }
      return { status: 'available', conversationId, startMessageId: messageId, endMessageId: items[end].id,
        start: items[start], end: items[end], page: page(conversationId, Math.max(0, start - 20), 100), rangeEndCursor: `${end}:100` }
    },
  }
}
