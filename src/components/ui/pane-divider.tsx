import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import './pane-divider.css'

const panes = {
  navigation: { label: '调整主导航宽度', edge: 'right', min: 196, max: 380, otherMin: 460 },
  providers: { label: '调整服务商列表宽度', edge: 'right', min: 164, max: 420, otherMin: 364 },
  assistant: { label: '调整原文与对话宽度', edge: 'left', min: 304, max: 1000, otherMin: 268 },
} as const

export function usePaneDivider(name: keyof typeof panes, active = true) {
  const pane = panes[name]
  const key = 'whomi:pane:' + name
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(key))
      return saved >= pane.min && saved <= pane.max ? saved : null
    } catch { return null }
  })
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; start: number; latest: number } | null>(null)
  const [measured, setMeasured] = useState(pane.min as number)
  const [dragging, setDragging] = useState(false)
  const direction = pane.edge === 'right' ? 1 : -1
  function save(value: number | null) {
    setWidth(value)
    try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, String(value))
    } catch { /* 仍可在当前窗口调整宽度。 */ }
  }
  function clamp(value: number, element: HTMLElement) {
    const available = element.parentElement!.parentElement!.clientWidth - pane.otherMin
    return Math.max(pane.min, Math.min(Math.round(value), pane.max, available))
  }
  useLayoutEffect(() => {
    const element = ref.current?.parentElement
    if (!element || !active) return
    function measure() { setMeasured(Math.round(element!.getBoundingClientRect().width)) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active])

  const divider = <div ref={ref} role="separator" aria-orientation="vertical" aria-label={pane.label}
    aria-valuemin={pane.min} aria-valuemax={pane.max} aria-valuenow={measured} tabIndex={0}
    className={`pane-divider pane-divider-${name}`} title="拖动调整宽度，双击恢复默认"
    onDoubleClick={() => save(null)}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return
      const start = event.currentTarget.parentElement!.getBoundingClientRect().width
      drag.current = { x: event.clientX, start, latest: start }
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
      drag.current.latest = clamp(drag.current.start + direction * (event.clientX - drag.current.x), event.currentTarget)
      setWidth(drag.current.latest)
    }}
    onLostPointerCapture={() => {
      if (drag.current) save(drag.current.latest)
      drag.current = null
      setDragging(false)
    }}
    onKeyDown={event => {
      if (event.key === 'Home') { event.preventDefault(); save(null); return }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const current = event.currentTarget.parentElement!.getBoundingClientRect().width
      save(clamp(current + (event.key === 'ArrowRight' ? 16 : -16) * direction, event.currentTarget))
    }} />
  return { divider, dragging, style: (width === null ? {} : { ['--pane-' + name]: width + 'px' }) as CSSProperties }
}
