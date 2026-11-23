import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Info } from 'lucide-react'

export function SettingHelp({ name, children }: { name: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // 原生对话框在浏览器顶层，提示也要随它挂载。
  const dialog = open ? trigger.current?.closest<HTMLElement>('dialog, [role="dialog"]') : null
  function handlePointerLeave(event: PointerEvent<HTMLElement>) {
    if (!trigger.current || !content.current) return
    const button = trigger.current.getBoundingClientRect()
    const popup = content.current.getBoundingClientRect()
    // 直接移入原生标题栏或移出窗口时，网页不会再收到移动事件。
    if (!event.nativeEvent.relatedTarget || event.clientX < Math.min(button.left, popup.left) ||
      event.clientX > Math.max(button.right, popup.right) || event.clientY < Math.min(button.top, popup.top) ||
      event.clientY > Math.max(button.bottom, popup.bottom)) setOpen(false)
  }
  return <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button ref={trigger} type="button" className="setting-help" aria-label={name + '说明'}
          onPointerLeave={handlePointerLeave}
          onClick={event => { event.preventDefault(); setOpen(true) }}>
          <Info size={15} aria-hidden="true" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal container={dialog}>
        <Tooltip.Content ref={content} className="tooltip setting-help-content" side="bottom" align="start" onPointerLeave={handlePointerLeave}
          collisionBoundary={dialog} sideOffset={5} collisionPadding={10} onEscapeKeyDown={event => {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}>
          {children}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
}
