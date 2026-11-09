const drafts = new Map<string, { text: string }>()
const listeners = new Map<string, Set<() => void>>()

export const getChatDraftCacheKey = (topicId: string) => `chat.composer_draft.${topicId}` as const

const EMPTY_DRAFT_CACHE = { text: '' }

export function readChatDraftCache(topicId: string) {
  return drafts.get(getChatDraftCacheKey(topicId)) ?? EMPTY_DRAFT_CACHE
}

export function subscribeChatDraftCache(topicId: string, listener: () => void) {
  const key = getChatDraftCacheKey(topicId)
  const subscribers = listeners.get(key) ?? new Set()
  subscribers.add(listener)
  listeners.set(key, subscribers)
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) listeners.delete(key)
  }
}

export function writeChatDraftCache(topicId: string, draft: { text: string }) {
  const key = getChatDraftCacheKey(topicId)
  if (readChatDraftCache(topicId).text === draft.text) return
  if (draft.text) drafts.set(key, { text: draft.text })
  else drafts.delete(key)
  listeners.get(key)?.forEach(listener => listener())
}
