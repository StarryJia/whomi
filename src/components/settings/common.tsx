import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export type LeaveGuard = (action: () => void) => void
export type RegisterGuard = (guard: LeaveGuard | null) => void

export function errorText(error: unknown, fallback = '操作失败，请重试。') {
  return error instanceof Error && error.message ? error.message : fallback
}
export function isModelBusy(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'MODEL_BUSY'
}

export function Modal({ title, children, onClose, busy = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement
    element?.showModal()
    element?.querySelector<HTMLElement>('[data-initial-focus],input:not([type=file]),select,textarea,h2')?.focus()
    return () => { element?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} aria-labelledby={titleId} className={`ms-dialog ${className}`} onCancel={event => { event.preventDefault(); if (!busy) onClose() }} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')).filter(element => {
      if (element.closest('[hidden]')) return false
      const closedDetails = element.closest('details:not([open])')
      return !closedDetails || element === closedDetails.querySelector(':scope > summary')
    })
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus() }
  }}>
    <header className="ms-modal-header"><h2 id={titleId} tabIndex={-1}>{title}</h2><button type="button" className="ms-icon" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={19} aria-hidden="true" /></button></header>
    {children}
  </dialog>
}

export function CheckBox({ checked, mixed = false, children, onChange, disabled = false }: { checked: boolean; mixed?: boolean; children: ReactNode; onChange: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <label className="ms-check"><input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />{children}</label>
}

export function Switch({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: () => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={`ms-toggle ${checked ? 'is-on' : ''}`} disabled={disabled} onClick={onChange}><span /></button>
}

export function LeaveDialog({ onSave, onDiscard, onContinue, busy, error }: { onSave: () => void; onDiscard: () => void; onContinue: () => void; busy: boolean; error?: string }) {
  return <Modal title="保存修改？" onClose={onContinue} busy={busy}>
    <div className="ms-modal-body"><p>有尚未保存的修改。</p>{error && <p className="ms-error" role="alert">{error}</p>}</div>
    <footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={onContinue}>继续编辑</button><button className="ms-button" disabled={busy} onClick={onDiscard}>放弃修改</button><button className="ms-button ms-primary" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存并离开'}</button></footer>
  </Modal>
}
