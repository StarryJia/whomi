import { useRef, useState, type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Info } from 'lucide-react'

export function SettingHelp({ name, children }: { name: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // 原生对话框在浏览器顶层，提示也要随它挂载。
  const dialog = open ? trigger.current?.closest<HTMLElement>('dialog, [role="dialog"]') : null
  return <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button ref={trigger} type="button" className="setting-help" aria-label={name + '说明'}
          onPointerLeave={event => {
            if (!content.current) return
            const button = event.currentTarget.getBoundingClientRect()
            const popup = content.current.getBoundingClientRect()
            // 一步移到标题栏时不会再收到网页内的移动事件。
            if (!event.relatedTarget || event.clientX < Math.min(button.left, popup.left) ||
              event.clientX > Math.max(button.right, popup.right) || event.clientY < Math.min(button.top, popup.top) ||
              event.clientY > Math.max(button.bottom, popup.bottom)) setOpen(false)
          }}
          onClick={event => { event.preventDefault(); setOpen(true) }}>
          <Info size={15} aria-hidden="true" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal container={dialog}>
        <Tooltip.Content ref={content} className="tooltip setting-help-content" side="bottom" align="start"
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
