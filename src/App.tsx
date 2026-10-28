import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  ChartNoAxesCombined,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { SidebarProvider, useSidebar } from './components/ui/sidebar'
import { Tooltip, TooltipProvider } from './components/ui/tooltip'
import { StartupIntro } from './components/startup-intro'
import { ConversationNavigation, ConversationReader, type Conversation } from './components/conversations'
import { FileImport } from './components/file-import'
import symbol from '../assets/branding/whomi-symbol.png'
import wordmark from '../assets/branding/whomi-wordmark.png'
import './styles.css'
import './components/conversations.css'

const destinations: { label: string; icon: LucideIcon }[] = [
  { label: '分析', icon: ChartNoAxesCombined },
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

interface AppProps { displayName?: string; conversations?: readonly Conversation[] }

function HomeShell({ displayName = '', conversations = [] }: AppProps) {
  const { open, isMobile, toggle, closeMobile } = useSidebar()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const restoreToggleFocus = useRef(false)
  const mainRef = useRef<HTMLElement>(null)
  const brandImageRef = useRef<HTMLImageElement>(null)
  const greetingRef = useRef<HTMLButtonElement>(null)
  const overviewTitleRef = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'cover' | 'overview' | 'import' | 'conversation'>('cover')
  const [activeId, setActiveId] = useState<string>()
  const activeConversation = conversations.find(conversation => conversation.id === activeId)
  const [introActive, setIntroActive] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const name = displayName.trim()
  const mobileDialog = isMobile && open

  const finishIntro = useCallback(() => {
    setIntroActive(false)
    requestAnimationFrame(() => greetingRef.current?.focus())
  }, [])

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
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button, [tabindex="0"]'))
      .filter(control => !control.closest('[inert], [hidden], [aria-hidden="true"]'))
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
    setView('cover')
    requestAnimationFrame(() => (mobileDialog ? link : greetingRef.current)?.focus())
  }

  function enterOverview() {
    setView('overview')
    requestAnimationFrame(() => overviewTitleRef.current?.focus())
  }

  function returnToCover() {
    setView('cover')
    requestAnimationFrame(() => greetingRef.current?.focus())
  }

  function openImport() {
    setView('import')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>('.file-drop-target')?.focus())
  }

  function openConversation(id: string) {
    setActiveId(id)
    setView('conversation')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLHeadingElement>('#conversation-title')?.focus())
  }

  return (
    <div className={clsx('app-shell', open && 'sidebar-open', introActive && 'startup-running')}>
      <a className="skip-link" href="#main-content" inert={mobileDialog || introActive}>跳到主要内容</a>
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
        inert={introActive}
      >
        <header className="sidebar-header">
          {open ? <>
            <Tooltip content="返回首页" side="bottom">
            <a className="brand-link" href="#main-content" aria-label="Whomi 首页" onClick={goHome}>
              <span className="brand-symbol" aria-hidden="true"><img ref={brandImageRef} src={symbol} alt="" width="1254" height="1254" /></span>
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
                <span className="brand-symbol" aria-hidden="true"><img ref={brandImageRef} src={symbol} alt="" width="1254" height="1254" /></span>
                <span className="brand-expand-icon" aria-hidden="true"><PanelLeftOpen /></span>
              </button>
            </Tooltip>
          )}
        </header>
        <nav className="sidebar-navigation" aria-label="主导航">
          {destinations.map((destination) => <UnavailableDestination key={destination.label} {...destination} />)}
          <ConversationNavigation wide={open} conversations={conversations} activeId={view === 'conversation' ? activeId : undefined}
            onImport={openImport} onSelect={openConversation} />
        </nav>
        <footer className="sidebar-footer">
          <UnavailableDestination label="设置" icon={Settings} />
        </footer>
      </aside>
      <main id="main-content" ref={mainRef} className={clsx('home', view === 'overview' && 'overview-home', view === 'conversation' && 'reading-home')} tabIndex={-1} inert={mobileDialog || introActive}>
        {view === 'cover' ? <>
          <h1 className="greeting">
            <button ref={greetingRef} className="greeting-action" type="button" aria-label={`Hello${name ? `，${name}` : ''}，进入个人总览`} onClick={enterOverview}>
              Hello{name && <>，<span className="greeting-name">{name}</span></>}
            </button>
          </h1>
        </> : view === 'import' ? <FileImport /> : view === 'conversation' && activeConversation ? <ConversationReader key={activeConversation.id} conversation={activeConversation} /> : (
          <section className="overview-empty" aria-labelledby="overview-title">
            <h1 id="overview-title" ref={overviewTitleRef} tabIndex={-1}>个人总览</h1>
            <p>还没有可查看的总览。</p>
            <button className="return-cover" type="button" onClick={returnToCover}>返回 Hello</button>
          </section>
        )}
      </main>
      {introActive && <StartupIntro targetRef={brandImageRef} onComplete={finishIntro} />}
    </div>
  )
}

export default function App(props: AppProps) {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={120}>
      <SidebarProvider><HomeShell {...props} /></SidebarProvider>
    </TooltipProvider>
  )
}
