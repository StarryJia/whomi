import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { AiApi } from '../../shared/ai-contract'
import type { DesktopApi, MessagePage } from '../../shared/desktop-api'
import type { InsightCitationWindow } from '../../shared/conversation-insights'
import { ReaderDialog } from '../ui/managed-row'
import { ReadOnlyMessages } from './read-only-messages'
import './insight-source-dialog.css'

type AvailableSource = Extract<InsightCitationWindow, { status: 'available' }>
export type InsightSourceDialogProps = {
  taskId: string; citationId: string; phrase: string; conversationTitle: string; fragmentCount: number
  onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null>
  client: Pick<DesktopApi, 'readMessages' | 'locateSource'>; readCitation: AiApi['readInsightCitation']
}

export function InsightSourceDialog({ taskId, citationId, phrase, conversationTitle, fragmentCount, onClose, returnFocus, client, readCitation }: InsightSourceDialogProps) {
  const heading = useId()
  const [current, setCurrent] = useState<AvailableSource>()
  const [fragment, setFragment] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [away, setAway] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const working = useRef(false)
  const source = useRef<AvailableSource>(undefined)
  const retry = useRef<() => void>(() => {})
  const restore = useRef<{ id: string; offset: number } | 'citation' | null>(null)

  const jump = useCallback(async (target: number) => {
    if (working.current) return
    working.current = true
    const ticket = ++generation.current
    setBusy(true); setError('')
    retry.current = () => { void jump(target) }
    try {
      const next = await readCitation({ taskId, citationId, fragmentIndex: target })
      if (ticket !== generation.current) return
      if (next.status !== 'available') { setError('引用原文无法定位，请重试。'); return }
      source.current = next
      restore.current = 'citation'
      setCurrent(next); setFragment(target); setAway(false)
    } catch {
      if (ticket === generation.current) setError('原文读取失败，请重试。')
    } finally {
      if (ticket === generation.current) { working.current = false; setBusy(false) }
    }
  }, [taskId, citationId, readCitation])

  useEffect(() => {
    source.current = undefined; working.current = false; setCurrent(undefined); setFragment(0)
    void jump(0)
    return () => { ++generation.current; working.current = false }
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
    if (working.current || !previous || !cursor || !viewport) return
    working.current = true; setBusy(true); setError('')
    const ticket = generation.current
    retry.current = () => { void load(direction) }
    try {
      const page = await client.readMessages({ conversationId: previous.conversationId, cursor, direction })
      if (ticket !== generation.current) return
      const top = viewport.getBoundingClientRect().top
      const visible = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > top)
      if (visible) restore.current = { id: visible.dataset.messageId!, offset: visible.getBoundingClientRect().top - top }
      const items = direction === 'before' ? [...page.items, ...previous.page.items] : [...previous.page.items, ...page.items]
      const merged: MessagePage = { ...previous.page, items: [...new Map(items.map(item => [item.id, item])).values()],
        ...(direction === 'before' ? { beforeCursor: page.beforeCursor } : { afterCursor: page.afterCursor }) }
      const next = { ...previous, page: merged }
      source.current = next; setCurrent(next)
    } catch {
      if (ticket === generation.current) setError('原文读取失败，请重试。')
    } finally {
      if (ticket === generation.current) { working.current = false; setBusy(false) }
    }
  }

  function onScroll() {
    const viewport = scroll.current
    if (!viewport || !source.current) return
    const bounds = viewport.getBoundingClientRect()
    const cited = [...viewport.querySelectorAll<HTMLElement>('[data-citation=true]')]
    if (viewport.clientHeight > 0) setAway(!cited.some(item => { const rect = item.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom }))
    if (error || working.current) return
    if (viewport.scrollTop < 120 && source.current.page.beforeCursor) void load('before')
    else if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120 && source.current.page.afterCursor) void load('after')
  }

  return <ReaderDialog busy={false} onDismiss={onClose} returnFocus={returnFocus} labelledBy={heading}>
    <div className="reader-modal-overlay" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="insight-source-card">
        <header className="insight-source-heading"><div><h2 id={heading}>原文 · {conversationTitle}</h2><p>引用：{phrase}</p></div>
          <button type="button" className="insight-source-close" aria-label="关闭原文" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="insight-source-top"><button type="button" disabled={busy || !current || fragment === 0} onClick={() => void jump(fragment - 1)}><ChevronUp aria-hidden="true" />上一段</button></div>
        {error && <p className="insight-source-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => retry.current()}>重试</button></p>}
        <div ref={scroll} className="insight-source-scroll" role="region" aria-label="引用聊天记录" tabIndex={0} aria-busy={busy} onScroll={onScroll}>
          {current && <ReadOnlyMessages messages={current.page.items} highlightIds={current.highlightIds} />}
          {busy && <p className="insight-source-loading" role="status">正在读取原文…</p>}
        </div>
        <footer className="insight-source-footer">
          {away && <button type="button" className="insight-source-return" onClick={returnToCitation}>回到引用</button>}
          <span>{fragment + 1} / {fragmentCount}</span><button type="button" disabled={busy || !current || fragment >= fragmentCount - 1} onClick={() => void jump(fragment + 1)}><ChevronDown aria-hidden="true" />下一段</button>
        </footer>
      </section>
    </div>
  </ReaderDialog>
}
