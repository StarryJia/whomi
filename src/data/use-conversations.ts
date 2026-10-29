import { useCallback, useEffect, useRef, useState } from 'react'
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
  const listBusy = useRef(false)
  const readerBusy = useRef(false)
  const listGeneration = useRef(0)
  const readerGeneration = useRef(0)
  const mounted = useRef(false)

  const updateWindow = useCallback((value: ReaderWindow | undefined) => {
    windowRef.current = value
    setCurrent(value)
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current
    ++readerGeneration.current
    readerBusy.current = false
    setLoading(false)
    if (windowRef.current?.sourceStatus === 'loading') updateWindow({ ...windowRef.current, sourceStatus: 'unavailable' })
    listBusy.current = true
    setListLoading(!!client)
    setListError(undefined)
    if (!client) { setConversations([]); setListCursor(null); cursorRef.current = null; listBusy.current = false; return }
    try {
      const page = await client.listConversations({ limit: 100 })
      if (!mounted.current || generation !== listGeneration.current) return
      setConversations(page.items)
      setListCursor(page.nextCursor)
      cursorRef.current = page.nextCursor
    } catch (failure) {
      if (mounted.current && generation === listGeneration.current) setListError(readError(failure))
    } finally {
      if (mounted.current && generation === listGeneration.current) { listBusy.current = false; setListLoading(false) }
    }
  }, [client, updateWindow])

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
    setListLoading(true)
    setListError(undefined)
    try {
      const page = await client.listConversations({ cursor: cursorRef.current, limit: 100 })
      if (!mounted.current || generation !== listGeneration.current) return
      setConversations(previous => [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))])
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
    try {
      const page = await client.readMessages({ conversationId, direction: 'after', limit: 100 })
      if (!mounted.current || generation !== readerGeneration.current) return
      updateWindow(windowPages(window, [page]))
    } catch (failure) {
      if (mounted.current && generation === readerGeneration.current) setError(readError(failure))
    } finally {
      if (mounted.current && generation === readerGeneration.current) { readerBusy.current = false; setLoading(false) }
    }
  }, [client, updateWindow])

  const locate = useCallback(async (request: LocateSourceInput) => {
    const generation = ++readerGeneration.current
    readerBusy.current = true
    const window = { ...emptyWindow(request.conversationId), sourceStatus: 'loading' as const }
    updateWindow(window)
    setLoading(!!client)
    setError(undefined)
    try {
      const located = await client?.locateSource(request)
      if (!mounted.current || generation !== readerGeneration.current) return
      if (!located || located.status === 'unavailable') updateWindow({ ...window, sourceStatus: 'unavailable' })
      else updateWindow(windowPages({ ...window, sourceStatus: 'available', range: { start: located.start, end: located.end } }, [located.page]))
    } catch {
      if (mounted.current && generation === readerGeneration.current) updateWindow({ ...window, sourceStatus: 'unavailable' })
    } finally {
      if (mounted.current && generation === readerGeneration.current) { readerBusy.current = false; setLoading(false) }
    }
  }, [client, updateWindow])

  const load = useCallback(async (direction: 'before' | 'after') => {
    const window = windowRef.current
    const cursor = direction === 'before' ? window?.beforeCursor : window?.afterCursor
    if (!client || !window || !cursor || readerBusy.current) return
    const generation = readerGeneration.current
    readerBusy.current = true
    setLoading(true)
    setError(undefined)
    try {
      // 游标固定页大小，定位窗口和普通阅读均延续原快照。
      const page = await client.readMessages({ conversationId: window.conversationId, cursor, direction })
      if (!mounted.current || generation !== readerGeneration.current) return
      const pages = direction === 'before' ? [page, ...window.pages].slice(0, 5) : [...window.pages, page].slice(-5)
      updateWindow(windowPages(window, pages))
    } catch (failure) {
      if (mounted.current && generation === readerGeneration.current) setError(readError(failure))
    } finally {
      if (mounted.current && generation === readerGeneration.current) { readerBusy.current = false; setLoading(false) }
    }
  }, [client, updateWindow])

  const loadBefore = useCallback(() => load('before'), [load])
  const loadAfter = useCallback(() => load('after'), [load])
  return { available: !!client, conversations, listCursor, listLoading, listError, current, loading, error,
    refresh, loadMore, open, locate, loadBefore, loadAfter }
}
