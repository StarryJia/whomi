import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleAlert, X } from 'lucide-react'
import './exception-notices.css'

type Notice = { key: string; title: string; detail?: string; blocking?: boolean }
type NoticeSource = { notice: Notice; visible: boolean } | { unresolved: ReadonlySet<string> }
type NoticeState = { sources: ReadonlyMap<string, NoticeSource>; dismissed: ReadonlySet<string> }
type NoticeContext = {
  publish: (source: string, entry?: NoticeSource) => void
  resolve: (key: string) => void
  addLayer: (layer: HTMLElement) => () => void
}

const ExceptionNotices = createContext<NoticeContext | null>(null)
const ScopeVisibility = createContext(true)

export function ExceptionNoticeScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(ScopeVisibility)
  return <ScopeVisibility.Provider value={parentActive && active}>{children}</ScopeVisibility.Provider>
}

function useNoticeSource() {
  const source = useId()
  const publish = useContext(ExceptionNotices)?.publish
  useLayoutEffect(() => () => publish?.(source), [source, publish])
  return useCallback((entry?: NoticeSource) => publish?.(source, entry), [source, publish])
}

export function useUnresolvedExceptionNotices(keys: ReadonlySet<string>) {
  const update = useNoticeSource()
  useLayoutEffect(() => update(keys.size ? { unresolved: keys } : undefined), [update, keys])
  return useContext(ExceptionNotices)?.resolve
}

export function useExceptionNotice(notice: Notice | null): void {
  const update = useNoticeSource()
  const visible = useContext(ScopeVisibility)
  const { key, title, detail, blocking } = notice ?? {}
  useLayoutEffect(() => {
    update(key && title ? { notice: { key, title, detail, blocking }, visible } : undefined)
  }, [update, visible, key, title, detail, blocking])
}

export function useExceptionNoticeLayer(ref: RefObject<HTMLElement | null>, active = true) {
  const addLayer = useContext(ExceptionNotices)?.addLayer
  useLayoutEffect(() => {
    if (active && ref.current) return addLayer?.(ref.current)
  }, [active, addLayer, ref])
}

export function ExceptionNotice({ title, detail, noticeKey, className, blocking }: {
  title: string; detail?: string; noticeKey?: string; className?: string; blocking?: boolean
}) {
  const source = useId()
  const context = useContext(ExceptionNotices)
  useExceptionNotice({ key: noticeKey ?? source, title, detail: detail === title ? undefined : detail, blocking })
  return context ? null : <span className={className} role="alert">{detail || title}</span>
}

function ExceptionNoticeCard({ notice, dismiss }: { notice: Notice; dismiss: () => void }) {
  const detailId = useId()
  const [expanded, setExpanded] = useState(false)
  return <li className="exception-notice">
    <div className="exception-notice-header">
      <CircleAlert className="exception-notice-symbol" aria-hidden="true" size={18} />
      <span className="exception-notice-title" role="alert">{notice.title}</span>
      {notice.detail && <button type="button" className="exception-notice-control exception-notice-disclosure" aria-label={expanded ? '收起详情' : '展开详情'}
        aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)}><ChevronDown aria-hidden="true" size={16} /></button>}
      {!notice.blocking && <button type="button" className="exception-notice-control" aria-label="关闭提醒" onClick={dismiss}><X aria-hidden="true" size={16} /></button>}
    </div>
    {notice.detail && <p id={detailId} className="exception-notice-detail" hidden={!expanded}>{notice.detail}</p>}
  </li>
}

function ExceptionNoticeViewport({ notices, dismiss, layer }: { notices: Notice[]; dismiss: (key: string) => void; layer?: HTMLElement }) {
  const viewport = useRef<HTMLElement>(null)
  const focusBeforeEntering = useRef<HTMLElement | null>(null)
  const usePopover = Boolean(layer && typeof HTMLElement.prototype.showPopover === 'function')
  useLayoutEffect(() => {
    const element = viewport.current
    if (!usePopover || !element) return
    element.showPopover()
    return () => { if (element.matches(':popover-open')) element.hidePopover() }
  }, [layer, usePopover])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!layer || !element) return
    const measure = () => layer.style.setProperty('--exception-notice-bottom', `${Math.ceil(element.getBoundingClientRect().bottom)}px`)
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    observer?.observe(element)
    return () => { observer?.disconnect(); layer.style.removeProperty('--exception-notice-bottom') }
  }, [layer])

  function dismissCard(key: string) {
    if (viewport.current?.contains(document.activeElement)) {
      const controls = Array.from(viewport.current.querySelectorAll<HTMLButtonElement>('.exception-notice-control'))
      const next = controls.find(control => control.closest('li') !== document.activeElement?.closest('li'))
      const target = next ?? focusBeforeEntering.current
      target?.focus({ preventScroll: true })
    }
    dismiss(key)
  }

  return <section ref={viewport} className="exception-notices" aria-label="异常提醒" data-exception-notices popover={usePopover ? 'manual' : undefined}
    onFocus={event => {
      if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) focusBeforeEntering.current = event.relatedTarget
    }}>
    <ul className="exception-notice-list">
      {notices.map(notice => <ExceptionNoticeCard key={notice.key} notice={notice} dismiss={() => dismissCard(notice.key)} />)}
    </ul>
  </section>
}

export function ExceptionNoticeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NoticeState>(() => ({ sources: new Map(), dismissed: new Set() }))
  const [layers, setLayers] = useState<HTMLElement[]>([])
  const publish = useCallback<NoticeContext['publish']>((source, entry) => {
    setState(current => {
      if (!entry && !current.sources.has(source)) return current
      const sources = new Map(current.sources)
      if (entry) sources.set(source, entry)
      else sources.delete(source)
      if (!current.dismissed.size) return { ...current, sources }
      const remaining = [...sources.values()]
      const dismissed = new Set([...current.dismissed].filter(key => remaining.some(item =>
        'notice' in item ? item.notice.key === key : item.unresolved.has(key))))
      return { sources, dismissed }
    })
  }, [])
  const addLayer = useCallback<NoticeContext['addLayer']>(layer => {
    setLayers(current => [...current, layer])
    return () => setLayers(current => current.filter(item => item !== layer))
  }, [])
  const dismiss = useCallback((key: string) => setState(current => ({ ...current, dismissed: new Set([...current.dismissed, key]) })), [])
  const resolve = useCallback((key: string) => setState(current => {
    if (!current.dismissed.has(key)) return current
    const dismissed = new Set(current.dismissed)
    dismissed.delete(key)
    return { ...current, dismissed }
  }), [])
  const context = useMemo(() => ({ publish, resolve, addLayer }), [publish, resolve, addLayer])
  const notices = new Map<string, Notice>()
  for (const source of state.sources.values()) {
    if (!('notice' in source) || !source.visible) continue
    const { notice } = source
    if (notice.blocking || (!state.dismissed.has(notice.key) && !notices.has(notice.key))) notices.set(notice.key, notice)
  }
  const layer = layers.at(-1)
  const viewport = notices.size ? <ExceptionNoticeViewport layer={layer} notices={[...notices.values()]} dismiss={dismiss} /> : null
  return <ExceptionNotices.Provider value={context}>
    {children}
    {layer ? createPortal(viewport, layer) : viewport}
  </ExceptionNotices.Provider>
}
