import { useRef, type RefObject } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import lensLayer from '../../assets/branding/whomi-lens-layer.png'
import faceLayer from '../../assets/branding/whomi-face-layer.png'
import './startup-intro.css'

gsap.registerPlugin(useGSAP)

type StartupIntroProps = {
  targetRef: RefObject<HTMLImageElement | null>
  onComplete: () => void
}

const duration = 3.8
const faceOrigin = '45.056% 46.252%'

export function StartupIntro({ targetRef, onComplete }: StartupIntroProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    let live = true
    let finished = false
    let timer: number | undefined
    let timeline: gsap.core.Timeline | undefined
    const root = rootRef.current!
    const scene = sceneRef.current!
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')

    function dispose() {
      window.clearTimeout(timer)
      timeline?.kill()
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', complete)
      document.removeEventListener('visibilitychange', handleVisibility)
      media.removeEventListener('change', handleMotion)
    }

    function complete() {
      if (!live || finished) return
      finished = true
      dispose()
      onComplete()
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        complete()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        root.focus({ preventScroll: true })
      }
    }

    function handleVisibility() {
      if (document.hidden) complete()
    }

    function handleMotion() {
      if (media.matches) complete()
    }

    root.focus({ preventScroll: true })
    window.addEventListener('keydown', handleKey)
    window.addEventListener('resize', complete)
    document.addEventListener('visibilitychange', handleVisibility)
    media.addEventListener('change', handleMotion)

    const target = targetRef.current?.getBoundingClientRect()
    if (media.matches || document.hidden || !target || target.width <= 0 || target.height <= 0) {
      timer = window.setTimeout(complete, 0)
    } else {
      const size = Math.min(300, window.innerWidth - 64, window.innerHeight * 0.52)
      const left = window.innerWidth / 2 - size * 0.45056
      const top = window.innerHeight / 2 - size * 0.46252
      const radius = size * 0.06
      const search = root.querySelector<HTMLElement>('.intro-search')!
      const face = root.querySelector<HTMLElement>('.intro-face')!
      const sidebar = root.parentElement?.querySelector<HTMLElement>('.sidebar')
      const home = root.parentElement?.querySelector<HTMLElement>('.home')

      try {
        gsap.set(scene, { width: size, height: size, left, top, transformOrigin: '0 0' })
        gsap.set(search, { x: 0, y: 0, rotation: 0 })
        gsap.set(face, { scale: 0.028, opacity: 1, transformOrigin: faceOrigin })
        if (sidebar) gsap.set(sidebar, { opacity: 0 })
        if (home) gsap.set(home, { opacity: 0 })

        const searchDuration = 2
        const endAngle = -90
        const orbit = { angle: endAngle - 360 / 1.7 * searchDuration }
        const setX = gsap.quickSetter(search, 'x', 'px')
        const setY = gsap.quickSetter(search, 'y', 'px')
        function updateSearch() {
          const angle = orbit.angle * Math.PI / 180
          // 将圆周终点放在原图坐标，保持固定半径与速度直到合成。
          setX(orbit.angle === endAngle ? 0 : Math.cos(angle) * radius)
          setY(orbit.angle === endAngle ? 0 : (Math.sin(angle) + 1) * radius)
        }
        updateSearch()

        timeline = gsap.timeline({
          id: 'whomi-startup',
          defaults: { ease: 'power2.inOut' },
          onComplete: complete,
        })
        timeline.addLabel('search', 0.2)
          .addLabel('approach', 0.2)
          .addLabel('pause', 1.45)
          .addLabel('rush', 1.75)
          .addLabel('brand', 2.2)
          .addLabel('home', 2.8)
          .to(search, { opacity: 1, duration: 0.2 }, 0)
          .to(orbit, {
            angle: endAngle,
            duration: searchDuration,
            ease: 'none',
            onUpdate: updateSearch,
          }, 'search')
          .to(face, { scale: 0.5, duration: 1.25, ease: 'power2.inOut' }, 'approach')
          .to(face, { scale: 1, duration: 0.45, ease: 'power3.in' }, 'rush')
          .to(scene, {
            x: target.left - left,
            y: target.top - top,
            scaleX: target.width / size,
            scaleY: target.height / size,
            duration: 1,
            ease: 'power3.inOut',
          }, 'home')
          .to(root.querySelector('.intro-canvas'), { opacity: 0, duration: 0.65 }, 2.9)
        if (sidebar) timeline.to(sidebar, { opacity: 1, duration: 0.65 }, 2.9)
        if (home) timeline.to(home, { opacity: 1, duration: 0.55 }, 3.25)
        // 后台限频或运行时中断时，也要释放开场覆盖层。
        timer = window.setTimeout(complete, duration * 1000 + 200)
      } catch {
        timer = window.setTimeout(complete, 0)
      }
    }

    return () => {
      live = false
      dispose()
    }
  }, { scope: rootRef, dependencies: [onComplete, targetRef], revertOnUpdate: true })

  return (
    <div ref={rootRef} className="startup-intro" role="dialog" aria-modal="true" aria-label="启动动画" tabIndex={-1}>
      <div className="intro-canvas" aria-hidden="true" />
      <div ref={sceneRef} className="intro-scene" aria-hidden="true">
        <div className="intro-parts">
          <div className="intro-face"><img src={faceLayer} alt="" width="1254" height="1254" /></div>
          <div className="intro-search"><img src={lensLayer} alt="" width="1254" height="1254" /></div>
        </div>
      </div>
    </div>
  )
}
