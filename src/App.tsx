import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  ClipboardList,
  ContactRound,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { SidebarProvider, useSidebar } from './components/ui/sidebar'
import { Tooltip, TooltipProvider } from './components/ui/tooltip'
import { StartupIntro } from './components/startup-intro'
import { HelloCover } from './components/hello-cover'
import { ConversationNavigation, ConversationReader, type Conversation } from './components/conversations'
import { FileImport } from './components/file-import'
import { getDesktopClient } from './data/desktop-client'
import { createPreviewClient } from './data/preview-client'
import { useConversations, type ConversationClient } from './data/use-conversations'
import type { DesktopApi } from './shared/desktop-api'
import type { ConversationAiAdapter } from './components/conversation-ai/types'
import { PersonalOverview } from './components/overview/personal-overview'
import { useOverviewFeedback } from './components/overview/use-overview-feedback'
import type { FeedbackSaver, OverviewData, SourceReference } from './components/overview/types'
import { ClarificationPage } from './components/clarification/clarification-page'
import { useClarification } from './components/clarification/use-clarification'
import type { ClarificationAdapter, ClarificationModel, ClarificationQuestion } from './components/clarification/types'
import symbol from '../assets/branding/whomi-symbol.png'
import wordmark from '../assets/branding/whomi-wordmark.png'
import './styles.css'
import './components/conversations.css'

const destinations: { label: string; icon: LucideIcon }[] = [
  { label: '分析管理', icon: ClipboardList },
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

export interface AppProps {
  client?: ConversationClient
  importApi?: DesktopApi
  displayName?: string
  conversations?: readonly Conversation[]
  overview?: OverviewData
  saveFeedback?: FeedbackSaver
  clarificationQuestion?: ClarificationQuestion
  clarificationModels?: readonly ClarificationModel[]
  clarificationAdapter?: ClarificationAdapter
  preview?: boolean
  conversationAiAdapter?: ConversationAiAdapter
  previewConversationId?: string
}

function HomeShell({ displayName = '', conversations, overview, saveFeedback,
  clarificationQuestion, clarificationModels = [], clarificationAdapter, conversationAiAdapter, previewConversationId, preview = false, importApi, client }: AppProps) {
  const api = importApi ?? (window.whomi ? getDesktopClient() : undefined)
  const queryClient = useMemo(() => client ?? (conversations ? createPreviewClient(conversations) : api), [client, conversations, api])
  const reader = useConversations(queryClient)
  const previewing = preview || !!conversations
  const [fromImport, setFromImport] = useState(false)
  const { open, isMobile, toggle, closeMobile } = useSidebar()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const restoreToggleFocus = useRef(false)
  const mainRef = useRef<HTMLElement>(null)
  const brandImageRef = useRef<HTMLImageElement>(null)
  const greetingRef = useRef<HTMLButtonElement>(null)
  const overviewTitleRef = useRef<HTMLHeadingElement>(null)
  const clarificationTitleRef = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'cover' | 'overview' | 'import' | 'conversation' | 'clarification'>(preview && previewConversationId ? 'conversation' : 'cover')
  const [coverKey, setCoverKey] = useState(0)
  const [activeId, setActiveId] = useState<string | undefined>(preview ? previewConversationId : undefined)
  const [source, setSource] = useState<SourceReference>()
  const [sourceOrigin, setSourceOrigin] = useState<'overview' | 'clarification'>('overview')
  const feedback = useOverviewFeedback(saveFeedback)
  const clarification = useClarification(clarificationAdapter)
  const activeSummary = reader.conversations.find(conversation => conversation.id === activeId)
  const saved = useCallback(() => { void reader.refresh() }, [reader.refresh])
  const sourceAvailable = (reference: SourceReference) => !!queryClient && !reference.unavailable
  const [introActive, setIntroActive] = useState(
    () => !(preview && previewConversationId) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (preview && previewConversationId) void reader.open(previewConversationId)
  }, [preview, previewConversationId, reader.open])
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
    setCoverKey(key => key + 1)
    setView('cover')
    requestAnimationFrame(() => (mobileDialog ? link : greetingRef.current)?.focus())
  }

  function enterOverview() {
    setView('overview')
    closeMobile()
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
    setSource(undefined)
    setFromImport(view === 'import')
    setActiveId(id)
    void reader.open(id)
    setView('conversation')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLHeadingElement>('#conversation-title')?.focus())
  }

  function openSource(reference: SourceReference, origin: 'overview' | 'clarification' = 'overview') {
    setSource(reference)
    setFromImport(false)
    setSourceOrigin(origin)
    setActiveId(reference.conversationId)
    setView('conversation')
    closeMobile()
    void reader.locate({ conversationId: reference.conversationId, messageId: reference.messageId,
      ...(reference.endMessageId ? { endMessageId: reference.endMessageId } : {}) })
  }

  function openClarification() {
    setView('clarification')
    closeMobile()
    requestAnimationFrame(() => clarificationTitleRef.current?.focus())
  }

  const overviewContent = <>
    {previewing && <p className="overview-preview-label">开发预览 · 全部内容为虚构示例 · 未写入真实存储</p>}
    {!queryClient && <p className="reader-availability">请在桌面应用中查看已保存的会话。</p>}
    <PersonalOverview data={overview ?? { materialStatus: reader.conversations.length ? 'unanalysed' : 'none', discoveries: [] }}
      headingRef={overviewTitleRef} onReturnToCover={returnToCover} onImport={openImport}
      onOpenSource={openSource} isSourceAvailable={sourceAvailable}
      feedback={feedback} />
  </>

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
          <Tooltip content="个人总览">
            <button className="nav-control" type="button" aria-label="个人总览" aria-current={view === 'overview' ? 'page' : undefined} onClick={enterOverview}>
              <span className="control-icon"><ContactRound aria-hidden="true" /></span>
              <span className="control-label" aria-hidden="true">个人总览</span>
            </button>
          </Tooltip>
          {destinations.map((destination) => <UnavailableDestination key={destination.label} {...destination} />)}
          <Tooltip content="问一问">
            <button className="nav-control" type="button" aria-label="问一问" aria-current={view === 'clarification' ? 'page' : undefined} onClick={openClarification}>
              <span className="control-icon"><MessageCircleQuestion aria-hidden="true" /></span>
              <span className="control-label" aria-hidden="true">问一问</span>
            </button>
          </Tooltip>
          <ConversationNavigation wide={open} conversations={reader.conversations} activeId={view === 'conversation' ? activeId : undefined}
            onImport={openImport} onSelect={openConversation} hasMore={!!reader.listCursor} loading={reader.listLoading}
            error={reader.listError} onLoadMore={() => { void reader.loadMore() }} onRefresh={() => { void reader.refresh() }} />
        </nav>
        <footer className="sidebar-footer">
          <UnavailableDestination label="设置" icon={Settings} />
        </footer>
      </aside>
      <main id="main-content" ref={mainRef} className={clsx('home', view === 'cover' && 'cover-home', (view === 'overview' || view === 'clarification') && 'overview-home', view === 'conversation' && 'reading-home')} tabIndex={-1} inert={mobileDialog || introActive}>
        {view === 'cover' ? <HelloCover key={coverKey} name={name} buttonRef={greetingRef} onEnter={enterOverview}>{overviewContent}</HelloCover>
          : view === 'import' ? <FileImport api={api} onSaved={saved} onOpenConversation={openConversation} />
          : view === 'conversation' && activeId && reader.current ? <ConversationReader
          key={`${activeId}-${source?.id ?? ''}`} conversation={{ id: activeId, title: activeSummary?.title ?? '会话', messages: reader.current.messages }}
          range={reader.current.range} sourceStatus={reader.current.sourceStatus} loading={reader.loading} error={reader.error} preview={previewing}
          beforeCursor={reader.current.beforeCursor} afterCursor={reader.current.afterCursor}
          messageCount={activeSummary?.messageCount} aiAdapter={conversationAiAdapter}
          onLocateMessage={message => reader.locate({ conversationId: activeId, messageId: message.id })}
          onBefore={reader.loadBefore} onAfter={reader.loadAfter} onRetry={() => { void reader.open(activeId) }}
          onReturn={source ? (sourceOrigin === 'clarification' ? openClarification : enterOverview) : fromImport ? openImport : undefined}
          returnLabel={fromImport ? '返回导入结果' : sourceOrigin === 'clarification' ? '返回问一问' : '返回个人总览'} /> : view === 'clarification' ? (
          <ClarificationPage question={clarificationQuestion} models={clarificationModels} controller={clarification}
            headingRef={clarificationTitleRef} preview={previewing}
            onOpenSource={reference => openSource(reference, 'clarification')}
            isSourceAvailable={sourceAvailable} />
        ) : overviewContent}
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
