import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import clsx from 'clsx'
import './hello-cover.css'

interface HelloCoverProps {
  name: string
  buttonRef: RefObject<HTMLButtonElement | null>
  onEnter: () => void
  children: ReactNode
}

export function HelloCover({ name, buttonRef, onEnter, children }: HelloCoverProps) {
  const [peeking, setPeeking] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [previewMounted, setPreviewMounted] = useState(false)
  const completed = useRef(false)

  function complete() {
    if (completed.current) return
    completed.current = true
    onEnter()
  }

  useEffect(() => {
    if (!revealing) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    // 后台页面可能不派发过渡结束事件，仍需完成已确认的进入操作。
    const timer = window.setTimeout(complete, 700)
    const handleMotion = () => { if (media.matches) complete() }
    media.addEventListener('change', handleMotion)
    return () => {
      window.clearTimeout(timer)
      media.removeEventListener('change', handleMotion)
    }
  }, [revealing, onEnter])

  function enter() {
    if (revealing || completed.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      complete()
    } else {
      setPreviewMounted(true)
      setRevealing(true)
    }
  }

  return <div className={clsx('hello-cover', peeking && 'is-peeking', revealing && 'is-revealing')}>
    <div className="hello-cover-preview" inert aria-hidden="true">
      {previewMounted && children}
    </div>
    <div className="hello-cover-veil" aria-hidden="true" onTransitionEnd={event => {
      if (revealing && event.target === event.currentTarget && event.propertyName === 'opacity') complete()
    }} />
    <div className="hello-cover-copy">
      <h1 className="greeting">Hello{name && <>，<span className="greeting-name">{name}</span></>}</h1>
    </div>
    <button ref={buttonRef} className="greeting-action" type="button"
      aria-label={`Hello${name ? `，${name}` : ''}，进入个人总览`} aria-disabled={revealing || undefined}
      onPointerEnter={event => {
        if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
        setPreviewMounted(true)
        setPeeking(true)
      }}
      onPointerLeave={() => setPeeking(false)} onClick={enter} />
  </div>
}
