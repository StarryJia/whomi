import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEventHandler, type MouseEventHandler, type PointerEventHandler } from 'react'
import type { MessageView } from '../../shared/desktop-api'

export type ReferenceRange = { id: string; messages: readonly MessageView[] }

export function compareMessages(left: MessageView, right: MessageView) {
  if (left.timeBucket !== right.timeBucket) return left.timeBucket - right.timeBucket
  if (left.sortTime !== right.sortTime) return left.sortTime < right.sortTime ? -1 : 1
  if (left.id === right.id) return 0
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) return BigInt(left.id) < BigInt(right.id) ? -1 : 1
  return left.id < right.id ? -1 : 1
}

/** 邻接只取自实际读过的连续窗口，消息编号和导入序号均不能证明连续。 */
export function groupReferences(selected: ReadonlyMap<string, MessageView>, next: ReadonlyMap<string, string>): ReferenceRange[] {
  const groups: Array<{ id: string; messages: MessageView[] }> = []
  for (const message of [...selected.values()].sort(compareMessages)) {
    const last = groups.at(-1)
    const previous = last?.messages.at(-1)
    if (last && previous?.conversationId === message.conversationId && next.get(previous.id) === message.id) last.messages.push(message)
    else groups.push({ id: message.id, messages: [message] })
  }
  return groups
}

type Bindings = {
  onClick: MouseEventHandler<HTMLElement>
  onPointerDown: PointerEventHandler<HTMLElement>
  onPointerMove: PointerEventHandler<HTMLElement>
  onPointerUp: PointerEventHandler<HTMLElement>
  onPointerCancel: PointerEventHandler<HTMLElement>
  onKeyDown: KeyboardEventHandler<HTMLElement>
}
type Gesture = {
  anchor: string; pointerId: number; element: HTMLElement; reader: HTMLElement | null
  x: number; y: number; lastX: number; lastY: number; active: boolean; moved: boolean
  baseline: Map<string, MessageView>; remove: boolean; timer?: ReturnType<typeof setTimeout>; frame?: number
  release: () => void
}

export function useMessageSelection(messages: readonly MessageView[], enabled = true) {
  const [selected, setSelected] = useState<Map<string, MessageView>>(() => new Map())
  const [next, setNext] = useState<Map<string, string>>(() => new Map())
  const live = useRef({ messages, selected })
  live.current = { messages, selected }
  const anchor = useRef<string | undefined>(undefined)
  const gesture = useRef<Gesture | undefined>(undefined)
  const suppressClick = useRef(false)

  useLayoutEffect(() => {
    setNext(previous => {
      const visible = new Set(messages.map(message => message.id))
      // 只保留当前窗口和已选消息的边，长会话翻页不会积累全量消息。
      const updated = new Map([...previous].filter(([from, to]) => visible.has(from) || visible.has(to) || selected.has(from) || selected.has(to)))
      for (let index = 1; index < messages.length; index++) {
        if (messages[index - 1].conversationId === messages[index].conversationId) updated.set(messages[index - 1].id, messages[index].id)
      }
      return previous.size === updated.size && [...updated].every(([from, to]) => previous.get(from) === to) ? previous : updated
    })
  }, [messages, selected])

  const finish = useCallback((cancelled = false) => {
    const current = gesture.current
    if (!current) return
    gesture.current = undefined
    clearTimeout(current.timer)
    if (current.frame !== undefined) cancelAnimationFrame(current.frame)
    current.release()
    current.reader?.removeAttribute('data-selection-dragging')
    try { current.element.releasePointerCapture?.(current.pointerId) } catch { /* 已释放的指针不再持有捕获。 */ }
    suppressClick.current = current.active || current.moved
    if (cancelled && current.active) setSelected(current.baseline)
  }, [])

  useLayoutEffect(() => () => finish(), [finish])
  useLayoutEffect(() => {
    if (!enabled) { finish(); suppressClick.current = false }
  }, [enabled, finish])

  function applyRange(from: string, to: string, baseline: Map<string, MessageView>, remove = false) {
    const items = live.current.messages
    const start = items.findIndex(message => message.id === from)
    const end = items.findIndex(message => message.id === to)
    if (start < 0 || end < 0) return
    const updated = new Map(baseline)
    for (const message of items.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      if (remove) updated.delete(message.id)
      else updated.set(message.id, message)
    }
    setSelected(updated)
  }

  function toggle(message: MessageView) {
    setSelected(previous => {
      const updated = new Map(previous)
      if (updated.has(message.id)) updated.delete(message.id)
      else updated.set(message.id, message)
      return updated
    })
    anchor.current = message.id
  }

  function updatePoint(current: Gesture) {
    const rect = current.reader?.getBoundingClientRect()
    const y = rect ? Math.max(rect.top + 2, Math.min(rect.bottom - 2, current.lastY)) : current.lastY
    const target = document.elementFromPoint?.(current.lastX, y)?.closest<HTMLElement>('[data-message-id]')
    if (target?.dataset.messageId && current.reader?.contains(target)) applyRange(current.anchor, target.dataset.messageId, current.baseline, current.remove)
  }

  function autoScroll(current: Gesture) {
    if (gesture.current !== current || !current.active) return
    const reader = current.reader
    if (reader) {
      const rect = reader.getBoundingClientRect()
      const edge = 40
      const amount = current.lastY < rect.top + edge ? -Math.min(16, (rect.top + edge - current.lastY) / 3)
        : current.lastY > rect.bottom - edge ? Math.min(16, (current.lastY - rect.bottom + edge) / 3) : 0
      if (amount) {
        reader.scrollTop += amount
        updatePoint(current)
      }
    }
    current.frame = requestAnimationFrame(() => autoScroll(current))
  }

  function bindings(message: MessageView): Bindings {
    return {
      onClick(event) {
        if (!enabled) return
        if (suppressClick.current) { suppressClick.current = false; return }
        if (window.getSelection()?.toString()) return
        if (event.shiftKey && anchor.current && live.current.messages.some(item => item.id === anchor.current)) {
          applyRange(anchor.current, message.id, live.current.selected)
        } else toggle(message)
      },
      onPointerDown(event) {
        if (!enabled || event.button !== 0 || event.isPrimary === false) return
        finish()
        suppressClick.current = false
        const up = () => finish()
        const cancel = () => finish(true)
        const preventTouchScroll = (event: TouchEvent) => {
          if (gesture.current?.active && event.cancelable) event.preventDefault()
        }
        const preventContextMenu = (event: Event) => {
          if (gesture.current?.active) event.preventDefault()
        }
        const followScroll = () => {
          if (gesture.current === current && current.active) updatePoint(current)
        }
        const current: Gesture = {
          anchor: message.id, pointerId: event.pointerId, element: event.currentTarget,
          reader: event.currentTarget.closest<HTMLElement>('.reader-scroll'),
          x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY,
          active: false, moved: false, baseline: new Map(live.current.selected), remove: live.current.selected.has(message.id),
          release: () => {
            document.removeEventListener('pointerup', up)
            document.removeEventListener('pointercancel', cancel)
            document.removeEventListener('touchmove', preventTouchScroll)
            document.removeEventListener('contextmenu', preventContextMenu)
            current.reader?.removeEventListener('scroll', followScroll)
          },
        }
        document.addEventListener('pointerup', up)
        document.addEventListener('pointercancel', cancel)
        document.addEventListener('touchmove', preventTouchScroll, { passive: false })
        document.addEventListener('contextmenu', preventContextMenu)
        current.reader?.addEventListener('scroll', followScroll, { passive: true })
        gesture.current = current
        current.timer = setTimeout(() => {
          if (gesture.current !== current || current.moved) return
          current.active = true
          anchor.current = message.id
          current.reader?.setAttribute('data-selection-dragging', 'true')
          window.getSelection()?.removeAllRanges()
          try { current.element.setPointerCapture?.(current.pointerId) } catch { /* 平台不支持时仍可逐条选择。 */ }
          applyRange(current.anchor, current.anchor, current.baseline, current.remove)
          autoScroll(current)
        }, 250)
      },
      onPointerMove(event) {
        const current = gesture.current
        if (!current || current.pointerId !== event.pointerId) return
        current.lastX = event.clientX
        current.lastY = event.clientY
        if (!current.active) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) {
            current.moved = true
            clearTimeout(current.timer)
          }
          return
        }
        event.preventDefault()
        updatePoint(current)
      },
      onPointerUp() { finish() },
      onPointerCancel() { finish(true) },
      onKeyDown(event) {
        if (!enabled) return
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          if (event.shiftKey && anchor.current) applyRange(anchor.current, message.id, live.current.selected)
          else toggle(message)
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const items = live.current.messages
          const index = items.findIndex(item => item.id === message.id)
          const target = items[index + (event.key === 'ArrowDown' ? 1 : -1)]
          if (!target) return
          event.preventDefault()
          if (event.shiftKey) {
            anchor.current ??= message.id
            applyRange(anchor.current, target.id, live.current.selected)
          }
          const reader = event.currentTarget.closest('.reader-scroll')
          Array.from(reader?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(element => element.dataset.messageId === target.id)?.focus()
        }
      },
    }
  }

  const clear = useCallback(() => { finish(); anchor.current = undefined; setSelected(new Map()) }, [finish])
  const references = useMemo(() => groupReferences(selected, next), [selected, next])
  return { selectedIds: useMemo(() => new Set(selected.keys()), [selected]), references, clear, bindings }
}
