import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { AiApi } from '../../shared/ai-contract'
import type { DesktopApi, MessagePage } from '../../shared/desktop-api'
import type { InsightCitationWindow } from '../../shared/conversation-insights'
import { ReaderDialog } from '../ui/managed-row'
import { ExceptionNotice } from '../ui/exception-notices'
import { ReadOnlyMessages } from './read-only-messages'
import './insight-source-dialog.css'

type AvailableSource = Extract<InsightCitationWindow, { status: 'available' }>
type PendingRead = { kind: 'fragment'; index: number } | { kind: 'context' }
export type InsightSourceDialogProps = {
  taskId: string; citationId: string; phrase: string; conversationTitle: string; fragmentCount: number
  onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null>
  client: Pick<DesktopApi, 'readMessages'>; readCitation: AiApi['readInsightCitation']
}

export function InsightSourceDialog({ taskId, citationId, phrase, conversationTitle, fragmentCount, onClose, returnFocus, client, readCitation }: InsightSourceDialogProps) {
  const heading = useId()
  const [current, setCurrent] = useState<AvailableSource>()
  const [fragment, setFragment] = useState(0)
  const [pending, setPending] = useState<PendingRead | null>(null)
  const [error, setError] = useState('')
  const [away, setAway] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const active = useRef<PendingRead | null>(null)
  const source = useRef<AvailableSource>(undefined)
  const retry = useRef<() => void>(() => {})
  const restore = useRef<{ id: string; offset: number } | 'citation' | null>(null)

  const track = useCallback((request: PendingRead | null) => {
    active.current = request
    setPending(request)
  }, [])

  const jump = useCallback(async (target: number) => {
    if (active.current?.kind === 'fragment' && active.current.index === target) return
    const request: PendingRead = { kind: 'fragment', index: target }
    track(request)
    setError('')
    retry.current = () => { void jump(target) }
    try {
      const next = await readCitation({ taskId, citationId, fragmentIndex: target })
      if (active.current !== request) return
      if (next.status !== 'available') { setError('引用原文无法定位，请重试。'); return }
      source.current = next
      restore.current = 'citation'
      setCurrent(next); setFragment(target); setAway(false)
    } catch {
      if (active.current === request) setError('原文读取失败，请重试。')
    } finally {
      if (active.current === request) track(null)
    }
  }, [taskId, citationId, readCitation, track])

  useLayoutEffect(() => {
    source.current = undefined
    restore.current = null
    setCurrent(undefined)
    setAway(false)
    setFragment(0)
    void jump(0)
    return () => { active.current = null }
  }, [jump])

  function returnToCitation() {
    const element = scroll.current?.querySelector<HTMLElement>('[data-citation=true]')
    element?.scrollIntoView({ block: 'center', behavior: 'instant' })
    setAway(false)
  }

  useLayoutEffect(() => {
    const anchor = restore.current, viewport = scroll.current
    if (!anchor || !viewport) return
    restore.current = null
    if (anchor === 'citation') { returnToCitation(); return }
    const message = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === anchor.id)
    if (message) viewport.scrollTop += message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
  }, [current])

  async function load(direction: 'before' | 'after') {
    const previous = source.current, viewport = scroll.current
    const cursor = previous?.page[direction === 'before' ? 'beforeCursor' : 'afterCursor']
    if (active.current || !previous || !cursor || !viewport) return
    const request: PendingRead = { kind: 'context' }
    track(request)
    setError('')
    retry.current = () => { void load(direction) }
    try {
      const page = await client.readMessages({ conversationId: previous.conversationId, cursor, direction })
      if (active.current !== request) return
      const top = viewport.getBoundingClientRect().top
      const visible = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > top)
      if (visible) restore.current = { id: visible.dataset.messageId!, offset: visible.getBoundingClientRect().top - top }
      const items = direction === 'before' ? [...page.items, ...previous.page.items] : [...previous.page.items, ...page.items]
      const merged: MessagePage = { ...previous.page, items: [...new Map(items.map(item => [item.id, item])).values()],
        ...(direction === 'before' ? { beforeCursor: page.beforeCursor } : { afterCursor: page.afterCursor }) }
      const next = { ...previous, page: merged }
      source.current = next; setCurrent(next)
    } catch {
      if (active.current === request) setError('原文读取失败，请重试。')
    } finally {
      if (active.current === request) track(null)
    }
  }

  function onScroll() {
    const viewport = scroll.current
    if (!viewport || !source.current) return
    const bounds = viewport.getBoundingClientRect()
    const cited = [...viewport.querySelectorAll<HTMLElement>('[data-citation=true]')]
    if (viewport.clientHeight > 0) setAway(!cited.some(item => { const rect = item.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom }))
    if (error || active.current) return
    if (viewport.scrollTop < 120 && source.current.page.beforeCursor) void load('before')
    else if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120 && source.current.page.afterCursor) void load('after')
  }

  function navigate(target: number) {
    scroll.current?.focus({ preventScroll: true })
    void jump(target)
  }
  const requestedFragment = pending?.kind === 'fragment' ? pending.index : undefined

  return <ReaderDialog busy={false} onDismiss={onClose} returnFocus={returnFocus} labelledBy={heading}>
    <div className="reader-modal-overlay" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="insight-source-card">
        <header className="insight-source-heading"><div><h2 id={heading} title={conversationTitle}>原文 · {conversationTitle}</h2><p>引用：{phrase}</p></div>
          <button type="button" autoFocus className="insight-source-close" aria-label="关闭原文" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="insight-source-top">
          {pending && <span className="insight-source-loading" role="status">正在读取原文…</span>}
          <button type="button" disabled={!current || fragment === 0 || requestedFragment === fragment - 1} onClick={() => navigate(fragment - 1)}><ChevronUp aria-hidden="true" />上一段</button>
        </div>
        <div ref={scroll} className="insight-source-scroll" role="region" aria-label="引用聊天记录" tabIndex={0} aria-busy={!!pending} onScroll={onScroll}>
          {current && <ReadOnlyMessages messages={current.page.items} highlightIds={current.highlightIds} />}
        </div>
        {error && <div className="insight-source-error">
          <ExceptionNotice title={error} />
          <button type="button" onClick={() => {
            scroll.current?.focus({ preventScroll: true })
            retry.current()
          }}>重试</button>
        </div>}
        <footer className="insight-source-footer">
          {away && <button type="button" className="insight-source-return" onClick={() => {
            if (active.current?.kind === 'fragment') track(null)
            scroll.current?.focus({ preventScroll: true })
            returnToCitation()
          }}>回到引用</button>}
          {current && <span>{fragment + 1} / {fragmentCount}</span>}
          <button type="button" disabled={!current || fragment >= fragmentCount - 1 || requestedFragment === fragment + 1} onClick={() => navigate(fragment + 1)}><ChevronDown aria-hidden="true" />下一段</button>
        </footer>
      </section>
    </div>
  </ReaderDialog>
}
