import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import {
  Archive,
  ChartNoAxesCombined,
  Gauge,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { SidebarProvider, useSidebar } from './components/ui/sidebar'
import { Tooltip, TooltipProvider } from './components/ui/tooltip'
import symbol from '../assets/branding/whomi-symbol.png'
import wordmark from '../assets/branding/whomi-wordmark.png'
import './styles.css'

const destinations: { label: string; icon: LucideIcon }[] = [
  { label: '数据导入', icon: Plus },
  { label: '会话资料库', icon: Archive },
  { label: '分析', icon: ChartNoAxesCombined },
  { label: '个人仪表台', icon: Gauge },
]

function UnavailableDestination({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <Tooltip
      content={
        <>
          {label}<span className="tooltip-divider" aria-hidden="true"> · </span>未开放
        </>
      }
    >
      <button className="nav-control" type="button" aria-label={label} aria-disabled="true">
        <span className="control-icon"><Icon aria-hidden="true" /></span>
        <span className="control-label" aria-hidden="true">{label}</span>
      </button>
    </Tooltip>
  )
}

function HomeShell({ displayName = '' }: { displayName?: string }) {
  const { open, isMobile, toggle, closeMobile } = useSidebar()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const restoreToggleFocus = useRef(false)
  const mainRef = useRef<HTMLElement>(null)
  const name = displayName.trim()
  const mobileDialog = isMobile && open

  useLayoutEffect(() => {
    if (restoreToggleFocus.current) {
      toggleRef.current?.focus()
      restoreToggleFocus.current = false
    }
  }, [open])

  function toggleSidebar() {
    restoreToggleFocus.current = true
    toggle()
  }

  function dismissMobile() {
    restoreToggleFocus.current = true
    closeMobile()
  }

  function handleNavigationKey(event: KeyboardEvent<HTMLElement>) {
    if (!mobileDialog) return
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissMobile()
    }
    if (event.key !== 'Tab') return
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href], button')
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  function goHome(event: MouseEvent<HTMLAnchorElement>) {
    const link = event.currentTarget
    requestAnimationFrame(() => (mobileDialog ? link : mainRef.current)?.focus())
  }

  return (
    <div className={clsx('app-shell', open && 'sidebar-open')}>
      <a className="skip-link" href="#main-content" inert={mobileDialog}>跳到主要内容</a>
      {mobileDialog && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="关闭导航面板"
          tabIndex={-1}
          onClick={dismissMobile}
        />
      )}
      <aside
        id="app-sidebar"
        className="sidebar"
        aria-label={mobileDialog ? '导航面板' : '应用导航'}
        role={mobileDialog ? 'dialog' : undefined}
        aria-modal={mobileDialog || undefined}
        onKeyDownCapture={handleNavigationKey}
      >
        <header className="sidebar-header">
          {open ? <>
            <Tooltip content="返回首页" side="bottom">
            <a className="brand-link" href="#main-content" aria-label="Whomi 首页" onClick={goHome}>
              <span className="brand-symbol" aria-hidden="true"><img src={symbol} alt="" width="1254" height="1254" /></span>
              <span className="brand-wordmark" aria-hidden="true"><img src={wordmark} alt="" width="1774" height="887" /></span>
            </a>
            </Tooltip>
            <Tooltip content="收起侧栏">
              <button
                ref={toggleRef}
                className="header-toggle"
                type="button"
                aria-label="收起侧栏"
                aria-expanded="true"
                aria-controls="app-sidebar"
                onClick={toggleSidebar}
              >
                <PanelLeftClose aria-hidden="true" />
              </button>
            </Tooltip>
          </> : (
            <Tooltip content="展开侧栏">
              <button
                ref={toggleRef}
                className="brand-link brand-expand"
                type="button"
                aria-label="展开侧栏"
                aria-expanded="false"
                aria-controls="app-sidebar"
                onClick={toggleSidebar}
              >
                <span className="brand-symbol" aria-hidden="true"><img src={symbol} alt="" width="1254" height="1254" /></span>
                <span className="brand-expand-icon" aria-hidden="true"><PanelLeftOpen /></span>
              </button>
            </Tooltip>
          )}
        </header>
        <nav className="sidebar-navigation" aria-label="主导航">
          {destinations.map((destination) => <UnavailableDestination key={destination.label} {...destination} />)}
        </nav>
        <footer className="sidebar-footer">
          <UnavailableDestination label="设置" icon={Settings} />
        </footer>
      </aside>
      <main id="main-content" ref={mainRef} className="home" tabIndex={-1} inert={mobileDialog}>
        <h1 className="greeting">Hello{name && <>，<span className="greeting-name">{name}</span></>}</h1>
      </main>
    </div>
  )
}

export default function App({ displayName }: { displayName?: string }) {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={120}>
      <SidebarProvider><HomeShell displayName={displayName} /></SidebarProvider>
    </TooltipProvider>
  )
}
