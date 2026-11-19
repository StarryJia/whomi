import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import {
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from 'lucide-react'
import clsx from 'clsx'
import { usePaneDivider } from './components/ui/pane-divider'
import { SidebarProvider, useSidebar } from './components/ui/sidebar'
import { AskIcon, HeartRoomIcon, InsightsIcon, OverviewIcon } from './components/ui/sidebar-icons'
import { Tooltip, TooltipProvider } from './components/ui/tooltip'
import { ExceptionNotice, ExceptionNoticeProvider, ExceptionNoticeScope, useExceptionNotice } from './components/ui/exception-notices'
import { StartupIntro } from './components/startup-intro'
import { HelloCover } from './components/hello-cover'
import { ConversationNavigation, ConversationReader, type Conversation } from './components/conversations'
import { FileImport } from './components/file-import'
import { SettingsPage } from './components/settings/settings-page'
import type { LeaveGuard } from './components/settings/common'
import { getDesktopClient } from './data/desktop-client'
import { createPreviewClient } from './data/preview-client'
import { createConversationAiClient } from './data/conversation-ai-client'
import { useConversations, type ConversationClient } from './data/use-conversations'
import { getSnapshotFailure, hasConfirmedImport, importError, importFailureNotice, isImportActive } from './data/use-import'
import type { DesktopApi } from './shared/desktop-api'
import type { ConversationAiAdapter } from './components/conversation-ai/types'
import type { AnalysisTask } from './shared/ai-contract'
import { currentOverviewContributions } from './shared/insight-overview'
import { RelationshipObservations, relationshipPreferences } from './components/overview/relationship-observations'
import { InsightsLibrary } from './components/insights/insights-library'
import { InsightSourceDialog } from './components/insights/insight-source-dialog'
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

function UnavailableDestination({ label, icon }: { label: string; icon: ReactElement }) {
  return (
    <Tooltip
      content={
        <>
          {label}<span className="tooltip-divider" aria-hidden="true"> · </span>未开放
        </>
      }
    >
      <button className="nav-control" type="button" aria-label={label} aria-disabled="true">
        <span className="control-icon">{icon}</span>
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
  clarificationQuestion, clarificationModels, clarificationAdapter, conversationAiAdapter, previewConversationId, preview = false, importApi, client }: AppProps) {
  const api = importApi ?? (window.whomi ? getDesktopClient() : undefined)
  const readInsightCitation = api?.ai?.readInsightCitation
  const [desktopAi, setDesktopAi] = useState<ConversationAiAdapter>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const settingsEntry = useRef<HTMLButtonElement>(null)
  const settingsLeave = useRef<LeaveGuard>(null)
  const [settingsLocked, setSettingsLocked] = useState(false)
  const settingsReturn = useRef<(() => void) | null>(null)
  const settingsChanged = useRef(false)
  useEffect(() => {
    let active = true
    if (api?.ai && !preview && !conversationAiAdapter) void createConversationAiClient(api.ai, api.settings).then(value => { if (active) setDesktopAi(value) }).catch(() => { if (active) setDesktopAi(undefined) })
    return () => { active = false }
  }, [api?.ai, api?.settings, preview, conversationAiAdapter, settingsRevision])
  const queryClient = useMemo(() => client ?? (conversations ? createPreviewClient(conversations) : api), [client, conversations, api])
  const reader = useConversations(queryClient)
  const previewing = preview || !!conversations
  const [fromImport, setFromImport] = useState(false)
  const { open, isMobile, toggle, closeMobile } = useSidebar()
  const navPane = usePaneDivider('navigation', open && !isMobile)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const restoreToggleFocus = useRef(false)
  const mainRef = useRef<HTMLElement>(null)
  const brandImageRef = useRef<HTMLImageElement>(null)
  const greetingRef = useRef<HTMLButtonElement>(null)
  const overviewTitleRef = useRef<HTMLHeadingElement>(null)
  const clarificationTitleRef = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'cover' | 'overview' | 'import' | 'conversation' | 'clarification' | 'library'>(preview && previewConversationId ? 'conversation' : 'cover')
  const [selectedMemory, setSelectedMemory] = useState<string>()
  const reportOrigin = useRef<'library' | 'overview' | 'conversation'>('library')
  const renameBusy = useRef(false)
  const removedReports = useRef(new Set<string>())
  const removedConversations = useRef(new Set<string>())
  const [conversationNavigationRequest, setConversationNavigationRequest] = useState(0)
  const [tasks, setTasks] = useState<AnalysisTask[]>([])
  const memories = useMemo(() => tasks.filter(task => task.state === 'completed' && !!task.report), [tasks])
  const [memoryEntry, setMemoryEntry] = useState<{ taskId?:string; origin:'overview'|'library' }>()
  const [memoryError, setMemoryError] = useState('')
  const [memoryLoading, setMemoryLoading] = useState(Boolean(api?.ai))
  const [memoryLoaded, setMemoryLoaded] = useState(false)
  const [memoryRevision, setMemoryRevision] = useState(0)
  const refreshMemories = useCallback(() => setMemoryRevision(revision => revision + 1), [])
  useEffect(() => {
    if (!api?.ai) return
    let active = true
    const changes = new Map<string, AnalysisTask | null>()
    setMemoryError('')
    setMemoryLoading(true)
    const unsubscribe = api.ai.onEvent(event => {
      if (!active || event.kind === 'turn') return
      if (event.kind === 'analysis-deleted') {
        removedReports.current.add(event.taskId)
        changes.set(event.taskId, null)
        setTasks(items => items.filter(task => task.id !== event.taskId))
        setSelectedMemory(id => id === event.taskId ? undefined : id)
      } else {
        const task = event.snapshot
        if (removedReports.current.has(task.id) || removedConversations.current.has(task.conversationId)) return
        const last = changes.get(task.id)
        if (last === null || (last && last.eventSequence > task.eventSequence)) return
        changes.set(task.id, task)
        setTasks(items => {
          const stored = items.find(item => item.id === task.id)
          if (stored && stored.eventSequence > task.eventSequence) return items
          return stored ? items.map(item => item.id === task.id ? task : item) : [task, ...items]
        })
        if (task.state === 'completed') refreshMemories()
      }
    })
    void api.ai.listAnalyses().then(snapshot => {
      if (!active) return
      // 初读期间也可能收到进度或删除事件，以较新的记录为准。
      const current = new Map(snapshot.map(task => [task.id, task]))
      for (const [id, task] of changes) {
        if (!task) current.delete(id)
        else if (task.eventSequence >= (current.get(id)?.eventSequence ?? -1)) current.set(id, task)
      }
      setTasks(items => {
        const known = new Map(items.map(task => [task.id, task]))
        return [...current.values()].filter(task => !removedReports.current.has(task.id) && !removedConversations.current.has(task.conversationId))
          .map(task => {
            const newer = known.get(task.id)
            return newer && newer.eventSequence > task.eventSequence ? newer : task
          })
      })
      setMemoryLoaded(true)
    }).catch(() => {
      if (active) setMemoryError('报告列表读取失败。')
    }).finally(() => { if (active) setMemoryLoading(false) })
    return () => { active = false; unsubscribe() }
  }, [api?.ai, memoryRevision, refreshMemories])
  const contributions = useMemo(() => {
    const sources = new Map(memories.map(task => [task.id, task]))
    return currentOverviewContributions(memories)
      .map(item => {
        const source = sources.get(item.taskId)
        return { ...item, title: source?.conversationTitle ?? '会话 ' + item.conversationId, counterpartName: source?.counterpartName,
          sourceReports: item.sourceTaskIds.map(id => ({ id, title: sources.get(id)?.title ?? '会话洞察' })) }
      })
  }, [memories])
  const preferences = useMemo(() => relationshipPreferences(contributions), [contributions])
  const [coverKey, setCoverKey] = useState(0)
  const [importKey, setImportKey] = useState(0)
  const [activeId, setActiveId] = useState<string | undefined>(preview ? previewConversationId : undefined)
  const [source, setSource] = useState<SourceReference>()
  const [sourceOrigin, setSourceOrigin] = useState<'overview' | 'clarification'>('overview')
  const feedback = useOverviewFeedback(saveFeedback)
  const clarification = useClarification(clarificationAdapter)
  const activeSummary = reader.conversations.find(conversation => conversation.id === activeId)
  const saved = useCallback(() => { void reader.refresh() }, [reader.refresh])
  const importCancelled = useCallback(() => { void reader.refresh({ preserveReader: true }) }, [reader.refresh])
  const [windowError, setWindowError] = useState<{ title: string; detail: string; count: number } | null>(null)
  useEffect(() => api?.onAppException?.(notice => setWindowError(previous => ({ ...notice, count: (previous?.count ?? 0) + 1 }))), [api])
  useExceptionNotice(windowError && { key: `desktop-window-${windowError.count}`, title: windowError.title, detail: windowError.detail })
  useExceptionNotice(reader.listError ? { key: 'conversation-list', title: '无法读取会话列表', detail: reader.listError } : null)
  const sourceAvailable = (reference: SourceReference) => !!queryClient && !reference.unavailable
  const [introActive, setIntroActive] = useState(
    () => !(preview && previewConversationId) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (preview && previewConversationId) void reader.open(previewConversationId)
  }, [preview, previewConversationId, reader.open])
  const name = displayName.trim()
  const mobileDialog = isMobile && open
  const [backgroundImport, setBackgroundImport] = useState<{ jobId: string; notice: NonNullable<ReturnType<typeof importFailureNotice>> } | null>(null)
  useEffect(() => api?.onImport?.(snapshot => {
    const notice = importFailureNotice(getSnapshotFailure(snapshot), snapshot.jobId)
    setBackgroundImport(current => notice ? { jobId: snapshot.jobId, notice } : current?.jobId === snapshot.jobId ? null : current)
  }), [api])
  const importVisible = view === 'import' && !settingsOpen && !mobileDialog && !introActive
  useExceptionNotice(importVisible ? null : backgroundImport?.notice ?? null)

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
    if (!mobileDialog || !event.currentTarget.contains(event.target as Node)) return
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

  function closeSettings(destination?: () => void) {
    setSettingsOpen(false)
    setSettingsLocked(false)
    if (settingsChanged.current) {
      setSettingsRevision(value => value + 1)
      settingsChanged.current = false
    }
    const restore = settingsReturn.current
    settingsReturn.current = null
    if (destination) destination()
    else requestAnimationFrame(restore ?? (() => settingsEntry.current?.focus()))
  }

  function navigateFromSidebar(destination: () => void) {
    if (renameBusy.current) return
    if (!settingsOpen) { destination(); return }
    closeMobile()
    settingsLeave.current?.(() => closeSettings(destination))
  }

  function goHome(event: MouseEvent<HTMLAnchorElement>) {
    if (settingsOpen || renameBusy.current) event.preventDefault()
    const link = event.currentTarget
    navigateFromSidebar(() => {
      setCoverKey(key => key + 1)
      setView('cover')
      requestAnimationFrame(() => (mobileDialog && !settingsOpen ? link : greetingRef.current)?.focus())
    })
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

  async function startNewImport() {
    let previous: string | null = null
    try { previous = localStorage.getItem('whomi:import-job') } catch { /* 无存储时使用当前会话。 */ }
    if (api && previous) {
      try {
        const task = await api.getImport(previous)
        if (isImportActive(task) || task.status === 'failed' || (task.status === 'completed' && !hasConfirmedImport(task))) {
          openImport()
          return
        }
      } catch (cause) {
        if (importError(cause).code !== 'IMPORT_RESULT_REMOVED') {
          openImport()
          return
        }
      }
    }
    try { localStorage.removeItem('whomi:import-job') } catch { /* ignore */ }
    setImportKey(key => key + 1)
    setView('import')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>('.import-dropzone')?.focus())
  }

  function openImport() {
    setView('import')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>('.import-dropzone')?.focus())
  }

  async function handleDeleteConversation(id: string) {
    if (!api) return
    await api.deleteConversation(id)
    if (!api.onConversationDeleted) forgetConversation(id)
  }

  const onConversationDeleted = useEffectEvent((id: string) => forgetConversation(id))
  useEffect(() => api?.onConversationDeleted?.(id => onConversationDeleted(id)), [api])

  function forgetConversation(id: string) {
    removedConversations.current.add(id)
    if (tasks.some(task => task.id === selectedMemory && task.conversationId === id)) setSelectedMemory(undefined)
    setTasks(entries => entries.filter(task => task.conversationId !== id))
    refreshMemories()
    if (activeId === id) {
      settingsReturn.current = null
      setActiveId(undefined)
      setSource(undefined)
      if (view === 'conversation') enterOverview()
    }
    reader.forgetConversation(id)
  }

  function openConversation(id: string, entry?: { origin:'overview'|'library'; taskId?:string }) {
    setMemoryEntry(entry)
    setSource(undefined)
    setFromImport(view === 'import')
    setActiveId(id)
    void reader.open(id)
    setView('conversation')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLHeadingElement>('#conversation-title')?.focus())
  }

  function openSource(reference: SourceReference, origin: 'overview' | 'clarification' = 'overview') {
    setMemoryEntry(undefined)
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

  function openLibrary(id?: string) {
    reportOrigin.current = id && (view === 'overview' || view === 'conversation') ? view : 'library'
    setSelectedMemory(id)
    setView('library')
    closeMobile()
  }

  function returnFromReport() {
    if (renameBusy.current) return
    setSelectedMemory(undefined)
    if (reportOrigin.current === 'overview') enterOverview()
    if (reportOrigin.current === 'conversation') {
      setView('conversation')
      requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>('.conversation-analysis-trigger')?.focus({ preventScroll: true }))
    }
  }

  function revealConversations() {
    if (!open) toggle()
    setConversationNavigationRequest(value => value + 1)
  }

  function publishTask(task: AnalysisTask) {
    if (removedReports.current.has(task.id) || removedConversations.current.has(task.conversationId)) return
    setTasks(items => {
      const previous = items.find(item => item.id === task.id)
      if (previous && previous.eventSequence > task.eventSequence) return items
      return previous ? items.map(item => item.id === task.id ? task : item) : [task, ...items]
    })
  }

  const overviewContent = (concealed = false) => <>
    {!concealed && previewing && <p className="overview-preview-label">开发预览 · 全部内容为虚构示例 · 未写入真实存储</p>}
    {!concealed && !queryClient && <p className="reader-availability">请在桌面应用中查看已保存的会话。</p>}
    <PersonalOverview concealed={concealed} status={!overview && !memoryLoaded && (memoryLoading || memoryError) ? (memoryLoading ? 'loading' : 'error')
      : !overview && !memories.length && !reader.conversations.length && (reader.listLoading || reader.listError) ? (reader.listLoading ? 'loading' : 'error') : 'ready'}
      readingError={!memoryLoaded && memoryError ? { title: '报告列表读取失败', noticeKey: 'reports-list' } : null}
      retry={() => { refreshMemories(); if (reader.listError) void reader.refresh() }} data={overview ?? { materialStatus: memories.length ? 'ready' : reader.conversations.length ? 'unanalysed' : 'none', discoveries: [], preferences }}
      conversationTitle={(activeSummary ?? reader.conversations[0])?.title}
      onOpenConversation={reader.conversations[0] ? () => openConversation(activeSummary?.id ?? reader.conversations[0].id, {origin:'overview'}) : undefined}
      onOpenMemory={memories[0] ? () => openLibrary(memories[0].id) : undefined}
      hasRelationshipObservations={contributions.length > 0}
      headingRef={overviewTitleRef} onReturnToCover={returnToCover} onImport={openImport}
      onOpenSource={openSource} isSourceAvailable={sourceAvailable}
      feedback={feedback}>
      <RelationshipObservations observations={contributions} onRead={openLibrary} />
    </PersonalOverview>
    {!concealed && memoryLoaded && memoryError && <p><ExceptionNotice title="报告列表读取失败" noticeKey="reports-list" /> <button type="button" onClick={refreshMemories}>重试</button></p>}
  </>

  return (
    <div style={navPane.style} className={clsx('app-shell', navPane.dragging && 'pane-resizing', open && 'sidebar-open', introActive && 'startup-running', window.whomi && !preview && 'desktop-shell')}>
      {window.whomi && !preview && (settingsOpen || view !== 'conversation') && <div className="desktop-drag-strip" aria-hidden="true" />}
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
        {open && !isMobile && navPane.divider}
        <header className="sidebar-header">
          {open ? <>
            <Tooltip content="返回首页" side="bottom">
            <a className="brand-link" href="#main-content" aria-label="Whomi 首页" aria-disabled={settingsLocked || undefined} onClick={goHome}>
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
        <nav className="sidebar-navigation" aria-label="主导航" inert={settingsLocked}>
          <Tooltip content="个人总览">
            <button className="nav-control" type="button" aria-label="个人总览" aria-current={!settingsOpen && view === 'overview' ? 'page' : undefined} onClick={() => navigateFromSidebar(enterOverview)}>
              <span className="control-icon"><OverviewIcon className="sidebar-icon" aria-hidden="true" /></span>
              <span className="control-label" aria-hidden="true">个人总览</span>
            </button>
          </Tooltip>
          <Tooltip content="对话洞察">
            <button className="nav-control" type="button" aria-label="对话洞察" aria-current={!settingsOpen && view === 'library' ? 'page' : undefined} onClick={() => navigateFromSidebar(() => openLibrary())}>
              <span className="control-icon"><InsightsIcon className="sidebar-icon" aria-hidden="true" /></span>
              <span className="control-label" aria-hidden="true">对话洞察</span>
            </button>
          </Tooltip>
          <Tooltip content="问一问">
            <button className="nav-control" type="button" aria-label="问一问" aria-current={!settingsOpen && view === 'clarification' ? 'page' : undefined} onClick={() => navigateFromSidebar(openClarification)}>
              <span className="control-icon"><AskIcon className="sidebar-icon" aria-hidden="true" /></span>
              <span className="control-label" aria-hidden="true">问一问</span>
            </button>
          </Tooltip>
          <UnavailableDestination label="心事屋" icon={<HeartRoomIcon className="sidebar-icon" aria-hidden="true" />} />
          <ConversationNavigation wide={open} conversations={reader.conversations} activeId={!settingsOpen && view === 'conversation' ? activeId : undefined}
            openRequest={conversationNavigationRequest}
            arrange={api?.arrangeConversation && (async change => { await api.arrangeConversation(change); await reader.refresh({ preserveReader: true }) })}
            remove={api?.deleteConversation && handleDeleteConversation}
            onImport={() => navigateFromSidebar(startNewImport)} onSelect={id => navigateFromSidebar(() => openConversation(id))} hasMore={!!reader.listCursor} loading={reader.listLoading}
            error={reader.listError} onLoadMore={() => { void reader.loadMore() }} onRefresh={() => { void reader.refresh() }} />
        </nav>
        <footer className="sidebar-footer">
          {api?.settings ? <button ref={settingsEntry} className="nav-control" type="button" aria-label="设置" aria-current={settingsOpen ? 'page' : undefined} onClick={() => {
            if (renameBusy.current) return
            closeMobile()
            setSettingsOpen(true)
          }}>
            <span className="control-icon"><Settings aria-hidden="true" /></span><span className="control-label" aria-hidden="true">设置</span>
          </button> : <UnavailableDestination label="设置" icon={<Settings aria-hidden="true" />} />}
        </footer>
      </aside>
      {/* 设置返回时复用原阅读器的草稿、引用和滚动位置。 */}
      <main id={settingsOpen ? undefined : 'main-content'} hidden={settingsOpen} ref={mainRef} className={clsx('home', view === 'cover' && 'cover-home', (view === 'overview' || view === 'clarification' || view === 'library') && 'overview-home', view === 'library' && 'insights-home', view === 'conversation' && 'reading-home')} tabIndex={-1} inert={settingsOpen || mobileDialog || introActive}>
        <ExceptionNoticeScope active={!settingsOpen && !mobileDialog && !introActive}>
        {view === 'cover' ? <HelloCover key={coverKey} name={name} buttonRef={greetingRef} onEnter={enterOverview}>{revealing => overviewContent(!revealing)}</HelloCover>
          : view === 'library' ? <InsightsLibrary tasks={tasks} selectedId={selectedMemory} onSelect={id => { reportOrigin.current = 'library'; setSelectedMemory(id) }}
            conversations={reader.conversations} onReturn={returnFromReport} onTask={(id, taskId) => openConversation(id, { origin: 'library', taskId })}
            onConversations={revealConversations}
            arrange={api?.ai?.arrangeAnalysis && (async change => { await api.ai!.arrangeAnalysis(change); refreshMemories() })}
            rename={api?.ai?.renameAnalysis && (async (taskId, title) => publishTask(await api.ai!.renameAnalysis({ taskId, title })))}
            onRenameBusy={busy => { renameBusy.current = busy }}
            remove={api?.ai?.deleteAnalysis && (async id => {
              await api.ai!.deleteAnalysis(id)
              removedReports.current.add(id)
              setTasks(items => items.filter(task => task.id !== id))
            })}
            onStop={api?.ai?.stopAnalysis && (async id => publishTask(await api.ai!.stopAnalysis(id)))}
            onContinue={api?.ai?.continueAnalysis && (async id => publishTask(await api.ai!.continueAnalysis(id)))}
            loading={memoryLoading} error={memoryError} retry={refreshMemories}
            renderSource={queryClient && readInsightCitation && (target => <InsightSourceDialog {...target}
              client={queryClient} readCitation={readInsightCitation} />)} />
          : view === 'import' ? <FileImport key={importKey} api={api} onSaved={saved} onCancelled={importCancelled} onOpenConversation={openConversation} />
          : view === 'clarification' ? <ClarificationPage question={clarificationQuestion} models={clarificationModels ?? (conversationAiAdapter ?? desktopAi)?.models.map(model => ({ ...model, available: true })) ?? []} controller={clarification}
            headingRef={clarificationTitleRef} preview={previewing}
            onOpenSource={reference => openSource(reference, 'clarification')}
            isSourceAvailable={sourceAvailable} /> : view === 'conversation' ? null : overviewContent()}
        {(view === 'conversation' || view === 'library' && selectedMemory && reportOrigin.current === 'conversation') && activeId && reader.current &&
          <div className="app-conversation-frame" hidden={view !== 'conversation'}><ExceptionNoticeScope active={view === 'conversation'}><ConversationReader
          key={`${activeId}-${source?.id ?? ''}-${memoryEntry?.taskId ?? memoryEntry?.origin ?? ''}`} conversation={{ id: activeId, title: activeSummary?.title ?? '会话', messages: reader.current.messages }}
          openAnalysisOnEntry={!!memoryEntry?.taskId} initialAnalysisTaskId={memoryEntry?.taskId}
          range={reader.current.range} sourceStatus={reader.current.sourceStatus} loading={reader.loading} error={reader.error} preview={previewing}
          beforeCursor={reader.current.beforeCursor} afterCursor={reader.current.afterCursor}
          messageCount={activeSummary?.messageCount} aiAdapter={conversationAiAdapter ?? desktopAi}
          sourceStartTimeMs={activeSummary?.firstSentAtMs} sourceEndTimeMs={activeSummary?.lastSentAtMs}
          onLocateMessageId={id => reader.locate({ conversationId: activeId, messageId: id }, { preserveOnFailure: true })}
          onBefore={reader.loadBefore} onAfter={reader.loadAfter} onRetry={() => { void reader.open(activeId) }}
          onReturn={source ? (sourceOrigin === 'clarification' ? openClarification : enterOverview) : memoryEntry ? (memoryEntry.origin === 'library' ? () => openLibrary() : enterOverview) : fromImport ? openImport : undefined}
          returnLabel={memoryEntry?.origin === 'library' ? '返回对话洞察' : fromImport ? '返回导入结果' : sourceOrigin === 'clarification' ? '返回问一问' : '返回个人总览'}
          api={api} onConfigureModels={api?.settings ? onReturn => { settingsReturn.current = onReturn; closeMobile(); setSettingsOpen(true) } : undefined} onOpenMemory={openLibrary} onSelfChanged={() => {
            setTasks(entries => entries.map(entry => entry.conversationId === activeId ? { ...entry, valid: false } : entry))
            refreshMemories()
            void reader.open(activeId)
          }} /></ExceptionNoticeScope></div>}
        </ExceptionNoticeScope>
      </main>
      {settingsOpen && api?.settings && <main id="main-content" className="settings-home" tabIndex={-1} inert={mobileDialog}>
        <SettingsPage api={api.settings} importDiagnostics={api.importDiagnostics} leaveRef={settingsLeave} onLockChange={setSettingsLocked}
          onChanged={() => { settingsChanged.current = true }} onClose={() => closeSettings()} />
      </main>}
      {introActive && <StartupIntro targetRef={brandImageRef} onComplete={finishIntro} />}
    </div>
  )
}

export default function App(props: AppProps) {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={120}>
      <ExceptionNoticeProvider><SidebarProvider><HomeShell {...props} /></SidebarProvider></ExceptionNoticeProvider>
    </TooltipProvider>
  )
}
