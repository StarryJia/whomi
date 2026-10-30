// Adapted from Cherry Studio f19aa72, packages/ui PageSidePanel (MIT).
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function ProviderSettingsDrawer({ title, children, onClose, footer, wide = false, busy = false }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean; busy?: boolean }) {
  const headerId = useId(), panel = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  const busyRef = useRef(busy); busyRef.current = busy
  useEffect(() => {
    const opener = document.activeElement
    panel.current?.focus()
    const siblings = Array.from(document.body.children).filter(element => element !== panel.current?.parentElement && element instanceof HTMLElement) as HTMLElement[]
    const states = siblings.map(element => element.inert)
    siblings.forEach(element => { element.inert = true })
    return () => { siblings.forEach((element, index) => { element.inert = states[index] }); if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])
  return createPortal(<div className="cherry-panel-root"><div data-slot="page-side-panel-backdrop" className="cherry-panel-backdrop" onClick={() => { if (!busyRef.current) closeRef.current() }} />
    <aside ref={panel} role="dialog" aria-modal="true" aria-labelledby={headerId} tabIndex={-1} data-slot="page-side-panel" className={`cherry-panel ${wide ? 'cherry-panel-wide' : ''}`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) closeRef.current() }
      if (event.key !== 'Tab') return
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(element => !element.closest('[hidden]'))
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus() }
    }}><header className="cherry-panel-header"><h2 id={headerId}>{title}</h2><button type="button" className="ms-icon" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={16} /></button></header>
      <div className="cherry-panel-body" data-slot="page-side-panel-body">{children}</div>{footer && <footer className="cherry-panel-footer">{footer}</footer>}
    </aside></div>, document.body)
}
