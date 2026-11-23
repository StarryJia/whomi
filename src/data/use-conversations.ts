import { useCallback, useEffect, useRef, useState } from 'react'
import { traceConversation } from './conversation-diagnostics'
import type { DesktopApi, ConversationSummary, LocateSourceInput, MessagePage, MessagePosition } from '../shared/desktop-api'

export type ConversationClient = Pick<DesktopApi, 'listConversations' | 'readMessages' | 'locateSource'>

export type ReaderWindow = {
  conversationId: string
  pages: MessagePage[]
  messages: MessagePage['items']
  beforeCursor: string | null
  afterCursor: string | null
  sourceStatus?: 'loading' | 'available' | 'unavailable'
  range?: { start: MessagePosition; end: MessagePosition }
}

function windowPages(window: ReaderWindow, pages: MessagePage[]): ReaderWindow {
  return { ...window, pages, messages: pages.flatMap(page => page.items),
    beforeCursor: pages[0]?.beforeCursor ?? null, afterCursor: pages.at(-1)?.afterCursor ?? null }
}
function emptyWindow(conversationId: string): ReaderWindow {
  return { conversationId, pages: [], messages: [], beforeCursor: null, afterCursor: null }
}
function readError(error: unknown) {
  return error && typeof error === 'object' && 'action' in error && typeof error.action === 'string'
    ? error.action : '读取失败，请重试。'
}

export function useConversations(client?: ConversationClient) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [listCursor, setListCursor] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string>()
  const [current, setCurrent] = useState<ReaderWindow>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const windowRef = useRef<ReaderWindow>(undefined)
  const cursorRef = useRef<string | null>(null)
  const loadedCount = useRef(0)
  const deletedDuringListRead = useRef(new Set<string>())
  const listBusy = useRef(false)
  const readerBusy = useRef(false)
  const listGeneration = useRef(0)
  const readerGeneration = useRef(0)
  const mounted = useRef(false)

  useEffect(() => { loadedCount.current = conversations.length }, [conversations])

  const updateWindow = useCallback((value: ReaderWindow | undefined) => {
    windowRef.current = value
    setCurrent(value)
  }, [])

  const refresh = useCallback(async (options?: { preserveReader?: boolean }): Promise<'success' | 'failed' | 'unknown'> => {
    const generation = ++listGeneration.current
    if (!options?.preserveReader) {
      ++readerGeneration.current
      readerBusy.current = false
      setLoading(false)
      if (windowRef.current?.sourceStatus === 'loading') updateWindow({ ...windowRef.current, sourceStatus: 'unavailable' })
    }
    listBusy.current = true
    deletedDuringListRead.current.clear()
    setListLoading(!!client)
    setListError(undefined)
    if (!client) { setConversations([]); setListCursor(null); cursorRef.current = null; listBusy.current = false; return 'unknown' }
    try {
      let page = await client.listConversations({ limit: 100 })
      while (options?.preserveReader && page.nextCursor && page.items.length < loadedCount.current && generation === listGeneration.current) {
        const next = await client.listConversations({ cursor: page.nextCursor, limit: 100 })
        page = { items: [...page.items, ...next.items], nextCursor: next.nextCursor }
      }
      if (!mounted.current || generation !== listGeneration.current) return 'unknown'
      setConversations(page.items.filter(item => !deletedDuringListRead.current.has(item.id)))
      setListCursor(page.nextCursor)
      cursorRef.current = page.nextCursor
      return 'success'
    } catch (failure) {
      if (!mounted.current || generation !== listGeneration.current) return 'unknown'
      setListError(readError(failure))
      return 'failed'
    } finally {
      if (mounted.current && generation === listGeneration.current) { listBusy.current = false; setListLoading(false) }
    }
  }, [client, updateWindow])

  const forgetConversation = useCallback((id: string) => {
    // 只过滤删除前已发出的列表读取，后续读取以数据库为准。
    if (listBusy.current) deletedDuringListRead.current.add(id)
    setConversations(items => items.filter(item => item.id !== id))
    if (windowRef.current?.conversationId === id) {
      ++readerGeneration.current
      readerBusy.current = false
      updateWindow(undefined)
      setLoading(false)
      setError(undefined)
    }
  }, [updateWindow])

  useEffect(() => {
    mounted.current = true
    updateWindow(undefined)
    setConversations([])
    setListCursor(null)
    cursorRef.current = null
    void refresh()
    return () => { mounted.current = false; ++listGeneration.current; ++readerGeneration.current }
  }, [refresh, updateWindow])

  const loadMore = useCallback(async () => {
    if (!client || listBusy.current || !cursorRef.current) return
    const generation = listGeneration.current
    listBusy.current = true
    deletedDuringListRead.current.clear()
    setListLoading(true)
    setListError(undefined)
    try {
      const page = await client.listConversations({ cursor: cursorRef.current, limit: 100 })
      if (!mounted.current || generation !== listGeneration.current) return
      const items = page.items.filter(item => !deletedDuringListRead.current.has(item.id))
      setConversations(previous => [...previous, ...items.filter(item => !previous.some(old => old.id === item.id))])
      setListCursor(page.nextCursor)
      cursorRef.current = page.nextCursor
    } catch (failure) {
      if (mounted.current && generation === listGeneration.current) setListError(readError(failure))
    } finally {
      if (mounted.current && generation === listGeneration.current) { listBusy.current = false; setListLoading(false) }
    }
  }, [client])

  const open = useCallback(async (conversationId: string) => {
    const generation = ++readerGeneration.current
    readerBusy.current = true
    const window = emptyWindow(conversationId)
    updateWindow(window)
    setLoading(!!client)
    setError(undefined)
    if (!client) { readerBusy.current = false; return }
    const operation = traceConversation('open')
    operation.step('read')
    try {
      const page = await client.readMessages({ conversationId, direction: 'after', limit: 100 })
      operation.step('read', { count: page.items.length, hasMore: !!page.afterCursor })
      if (!mounted.current || generation !== readerGeneration.current) { operation.end('unknown'); return }
      updateWindow(windowPages(window, [page]))
      operation.step('display')
      operation.end('success')
    } catch (failure) {
      operation.end('failed', failure)
      if (mounted.current && generation === readerGeneration.current) setError(readError(failure))
    } finally {
      if (mounted.current && generation === readerGeneration.current) { readerBusy.current = false; setLoading(false) }
    }
  }, [client, updateWindow])

  const locate = useCallback(async (request: LocateSourceInput, options: { preserveOnFailure?: boolean } = {}) => {
    const generation = ++readerGeneration.current
    readerBusy.current = true
    const window = { ...emptyWindow(request.conversationId), sourceStatus: 'loading' as const }
    const previous = options.preserveOnFailure && windowRef.current?.conversationId === request.conversationId ? windowRef.current : undefined
    // 引用定位等待期间保留原页，后一次跳转失败时也能恢复该页的来源状态。
    updateWindow(previous ?? window)
    setLoading(!!client)
    setError(undefined)
    const operation = traceConversation('locate')
    operation.step('locate')
    try {
      if (previous && !request.endMessageId && previous.messages.some(message => message.id === request.messageId)) {
        operation.step('locate', { found: true })
        operation.end('success')
        return true
      }
      const located = await client?.locateSource(request)
      if (!mounted.current || generation !== readerGeneration.current) { operation.end('unknown'); return false }
      if (!located || located.status === 'unavailable') {
        operation.step('locate', { found: false })
        operation.end('failed')
        updateWindow(previous ?? { ...window, sourceStatus: 'unavailable' })
        return false
      }
      const target = options.preserveOnFailure
        ? { ...emptyWindow(request.conversationId), ...(previous?.range ? { range: previous.range, sourceStatus: previous.sourceStatus } : {}) }
        : { ...window, sourceStatus: 'available' as const, range: { start: located.start, end: located.end } }
      updateWindow(windowPages(target, [located.page]))
      operation.step('read', { count: located.page.items.length })
      operation.step('locate', { found: true })
      operation.end('success')
      return true
    } catch (failure) {
      operation.end('failed', failure)
      if (mounted.current && generation === readerGeneration.current) updateWindow(previous ?? { ...window, sourceStatus: 'unavailable' })
      return false
    } finally {
      if (mounted.current && generation === readerGeneration.current) { readerBusy.current = false; setLoading(false) }
    }
  }, [client, updateWindow])

  const load = useCallback(async (direction: 'before' | 'after') => {
    const window = windowRef.current
    const cursor = direction === 'before' ? window?.beforeCursor : window?.afterCursor
    if (!client || !window || !cursor || readerBusy.current) return
    const operation = traceConversation('page')
    operation.step('read')
    const generation = readerGeneration.current
    readerBusy.current = true
    setLoading(true)
    setError(undefined)
    try {
      // 游标固定页大小，定位窗口和普通阅读均延续原快照。
      const page = await client.readMessages({ conversationId: window.conversationId, cursor, direction })
      operation.step('read', { count: page.items.length, hasMore: !!(direction === 'before' ? page.beforeCursor : page.afterCursor) })
      if (!mounted.current || generation !== readerGeneration.current) { operation.end('unknown'); return }
      const pages = direction === 'before' ? [page, ...window.pages].slice(0, 5) : [...window.pages, page].slice(-5)
      updateWindow(windowPages(window, pages))
      operation.step('display')
      operation.end('success')
    } catch (failure) {
      operation.end('failed', failure)
      if (mounted.current && generation === readerGeneration.current) setError(readError(failure))
    } finally {
      if (mounted.current && generation === readerGeneration.current) { readerBusy.current = false; setLoading(false) }
    }
  }, [client, updateWindow])

  const loadBefore = useCallback(() => load('before'), [load])
  const loadAfter = useCallback(() => load('after'), [load])
  return { available: !!client, conversations, listCursor, listLoading, listError, current, loading, error,
    refresh, forgetConversation, loadMore, open, locate, loadBefore, loadAfter }
}
