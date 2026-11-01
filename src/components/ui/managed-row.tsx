import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Pin, PinOff, Trash2 } from 'lucide-react'
import type { ListArrangement } from '../../shared/desktop-api'

export function ReaderDialog({ children, busy, onDismiss, returnFocus, labelledBy }: {
  children: ReactNode
  busy: boolean
  onDismiss: () => void
  returnFocus: RefObject<HTMLButtonElement | null>
  labelledBy: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (typeof element.close === 'function') element.close()
      returnFocus.current?.focus({ preventScroll: true })
    }
  }, [returnFocus])
  // 原生模态层隔离侧栏和窗口拖拽区域，并提供浏览器焦点约束。
  return createPortal(<dialog ref={dialog} className="reader-modal-root" aria-modal="true" aria-labelledby={labelledBy}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss() }}>{children}</dialog>, document.body)
}


export function actionError(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'action' in error && typeof error.action === 'string') return error.action
  return '操作失败，请重试。'
}

export function DeleteListItem({ title, thread, memory, onDelete, onDismiss, returnFocus }: {
  title: string; thread?: boolean; memory?: boolean; onDelete: () => Promise<void> | void; onDismiss: () => void
  returnFocus: RefObject<HTMLButtonElement | null>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    setBusy(true)
    setError('')
    try { await onDelete(); onDismiss() }
    catch (cause) { setError(actionError(cause)); setBusy(false) }
  }
  return <ReaderDialog busy={busy} onDismiss={onDismiss} returnFocus={returnFocus} labelledBy="delete-modal-title">
    <div className="reader-modal-overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onDismiss() }}>
      <div className="reader-modal-card">
        <h2 id="delete-modal-title">{memory ? '删除记忆' : thread ? '删除 AI 对话' : '删除会话'}</h2>
        <p className="reader-modal-description">{memory ? `将删除「${title}」及其整理进度，保留原始聊天和其他记忆。` : thread ? `将删除「${title}」的全部提问与回答。` : `将删除「${title}」的原文、成员、本人设置、关联 AI 对话和记忆成稿。`}此操作无法撤销。</p>
        {error && <p className="import-error" role="alert">{error}</p>}
        <div className="reader-modal-footer">
          <button type="button" className="reader-modal-btn" disabled={busy} onClick={onDismiss}>取消</button>
          <button type="button" className="reader-modal-btn reader-modal-btn-danger" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button>
        </div>
      </div>
    </div>
  </ReaderDialog>
}

type Row = { id: string; title: string; pinned?: boolean }
export function ManagedRow({ item, scope, className, active, disabled, children, onSelect, arrange, remove, memory, expanded, controls, hasPopup }: {
  item: Row; scope: string; className?: string; active: boolean; disabled?: boolean; children: ReactNode
  onSelect: () => void; arrange?: (change: ListArrangement) => Promise<void>; remove?: () => Promise<void>
  memory?: boolean; expanded?: boolean; controls?: string; hasPopup?: 'dialog'
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [deleting, setDeleting] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<{ change: ListArrangement; message: string }>()
  const [dropOver, setDropOver] = useState(false)
  const type = `application/x-whomi-${scope}-${item.pinned ? 'pinned' : 'normal'}`
  async function save(change: ListArrangement) {
    if (!arrange || pending) return
    setPending(true)
    setFailure(undefined)
    try { await arrange(change) }
    catch (cause) { setFailure({ change, message: actionError(cause) }) }
    finally { setPending(false) }
  }
  const row = <button ref={button} type="button" className={className} title={item.title} aria-label={item.title}
    aria-expanded={expanded} aria-controls={controls} aria-haspopup={hasPopup}
    aria-current={active || undefined} data-list-id={item.id} data-pinned={!!item.pinned} data-drop-over={dropOver || undefined}
    disabled={disabled || pending} draggable={!!arrange && !pending} onClick={onSelect}
    onKeyDown={event => {
      if ((!arrange && !remove) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bounds.left + Math.min(bounds.width / 2, 180), clientY: bounds.bottom }))
    }}
    onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(type, item.id) }}
    onDragOver={event => { if (arrange && event.dataTransfer.types.includes(type)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropOver(true) } }}
    onDragLeave={() => setDropOver(false)} onDragEnd={() => setDropOver(false)} onDrop={event => {
      setDropOver(false)
      const id = event.dataTransfer.getData(type)
      if (!id || id === item.id) return
      const target = event.currentTarget
      const source = target.closest('ul, nav')?.querySelector(`[data-list-id="${CSS.escape(id)}"]`)
      if (!source) return
      const placement = source.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before'
      event.preventDefault(); void save({ id, targetId: item.id, placement })
    }}>{children}{item.pinned && <Pin className="list-item-pin" size={14} aria-label="已置顶" />}</button>
  if (!arrange && !remove) return row
  return <>
    <ContextMenu.Root><ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal><ContextMenu.Content className="cherry-context-menu"
        onCloseAutoFocus={event => {
          event.preventDefault()
          requestAnimationFrame(() => {
            if (!document.activeElement?.closest('dialog[open]')) button.current?.focus({ preventScroll: true })
          })
        }}
        onPointerUpCapture={event => { if (event.button === 2) { event.preventDefault(); event.stopPropagation() } }}
        onEscapeKeyDown={event => event.stopPropagation()}>
        {arrange && <ContextMenu.Item className="cherry-menu-item" onSelect={() => void save({ id: item.id, pinned: !item.pinned })}>
          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}{item.pinned ? '取消置顶' : '置顶'}</ContextMenu.Item>}
        {remove && <ContextMenu.Item className="cherry-menu-item" data-destructive="true" onSelect={() => setDeleting(true)}><Trash2 size={14} />删除</ContextMenu.Item>}
      </ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>
    {failure && <div role="alert" className="conversation-list-error">{failure.message}<button type="button" onClick={() => void save(failure.change)}>重试</button></div>}
    {deleting && remove && <DeleteListItem title={item.title} thread={scope !== 'conversations'} memory={memory} returnFocus={button} onDismiss={() => setDeleting(false)} onDelete={remove} />}
  </>
}
