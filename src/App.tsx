import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  Archive,
  ContactRound,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { usePaneDivider } from './components/ui/pane-divider'
import { SidebarProvider, useSidebar } from './components/ui/sidebar'
import { Tooltip, TooltipProvider } from './components/ui/tooltip'
import { StartupIntro } from './components/startup-intro'
import { HelloCover } from './components/hello-cover'
import { ConversationNavigation, ConversationReader, type Conversation } from './components/conversations'
import { FileImport } from './components/file-import'
import { SettingsPage } from './components/settings/settings-page'
import { getDesktopClient } from './data/desktop-client'
import { createPreviewClient } from './data/preview-client'
import { createConversationAiClient } from './data/conversation-ai-client'
import { useConversations, type ConversationClient } from './data/use-conversations'
import { isImportActive, isPersistedResult } from './data/use-import'
import type { DesktopApi } from './shared/desktop-api'
import type { ConversationAiAdapter } from './components/conversation-ai/types'
import type { AnalysisTask } from './shared/ai-contract'
import { currentMemoryContributions, dimensionKeys } from './shared/memory'
import { RelationshipObservations, relationshipPreferences } from './components/overview/relationship-observations'
import { MemoryLibrary } from './components/memory-library'
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
  const [desktopAi, setDesktopAi] = useState<ConversationAiAdapter>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const settingsEntry = useRef<HTMLButtonElement>(null)
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
  const [tasks, setTasks] = useState<AnalysisTask[]>([])
  const memories = useMemo(() => tasks.filter(task => task.state === 'completed' && !!task.report), [tasks])
  const unfinished = useMemo(() => tasks.filter(task => task.valid && task.state !== 'completed'), [tasks])
  const [memoryEntry, setMemoryEntry] = useState<{ taskId?:string; origin:'overview'|'library' }>()
  const returnFromQuestion = useRef<typeof view>('overview')
  const [memoryError, setMemoryError] = useState('')
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryRevision, setMemoryRevision] = useState(0)
  const refreshMemories = useCallback(() => setMemoryRevision(revision => revision + 1), [])
  useEffect(() => {
    if (!api?.ai || (view !== 'overview' && view !== 'library' && view !== 'cover')) return
    let active = true
    setMemoryError('')
    setMemoryLoading(true)
    void api.ai.listAnalyses().then(tasks => {
      if (active) setTasks(tasks)
    }).catch(() => {
      if (active) setMemoryError('读取记忆失败。')
    }).finally(() => { if (active) setMemoryLoading(false) })
    const unsubscribe = api.ai.onEvent(event => {
      if (event.kind !== 'analysis' || !active) return
      if (event.snapshot.state === 'completed') refreshMemories()
      else setTasks(items => [event.snapshot, ...items.filter(task => task.id !== event.snapshot.id)])
    })
    return () => { active = false; unsubscribe() }
  }, [api?.ai, view, memoryRevision, refreshMemories])
  const contributions = useMemo(() => {
    const titles = new Map(memories.map(task => [task.id, task.conversationTitle]))
    return currentMemoryContributions(memories).filter(item => dimensionKeys.some(key => item.dimensions[key]))
      .map(item => ({ ...item, title: titles.get(item.taskId) ?? '会话 ' + item.conversationId }))
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

  async function startNewImport() {
    let previous: string | null = null
    try { previous = localStorage.getItem('whomi:import-job') } catch { /* 无存储时使用当前会话。 */ }
    if (api && previous) {
      try {
        const task = await api.getImport(previous)
        if (isImportActive(task) || task.status === 'failed' || task.status === 'partially_completed' ||
          (task.status === 'cancelled' && task.results.some(isPersistedResult))) {
          openImport()
          return
        }
      } catch {
        // 让导入页保留原任务的错误与恢复操作。
        openImport()
        return
      }
    }
    try { localStorage.removeItem('whomi:import-job') } catch { /* ignore */ }
    setImportKey(key => key + 1)
    setView('import')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>('.file-drop-target')?.focus())
  }

  function openImport() {
    setView('import')
    closeMobile()
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>('.file-drop-target')?.focus())
  }

  async function handleDeleteConversation(id: string) {
    if (!api) return
    await api.deleteConversation(id)
    setTasks(entries => entries.filter(task => task.conversationId !== id))
    refreshMemories()
    await reader.refresh({ preserveReader: true })
    if (activeId === id && view === 'conversation') {
      setActiveId(undefined)
      enterOverview()
    }
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
    if (view !== 'clarification' && !(view === 'conversation' && source && sourceOrigin === 'clarification')) returnFromQuestion.current = view
    setView('clarification')
    closeMobile()
    requestAnimationFrame(() => clarificationTitleRef.current?.focus())
  }

  const questionReturnLabel = {cover:'返回 Hello', overview:'返回个人总览', library:'返回记忆仓库', import:'返回导入', conversation:'返回会话', clarification:'返回个人总览'}[returnFromQuestion.current]
  function leaveClarification() {
    switch (returnFromQuestion.current) {
      case 'cover': return returnToCover()
      case 'library': return openLibrary()
      case 'import': return openImport()
      case 'conversation': if (activeId && activeSummary) return openConversation(activeId)
    }
    enterOverview()
  }
  function openLibrary(id?: string) {
    setSelectedMemory(id)
    setView('library')
    closeMobile()
  }

  const overviewContent = <>
    {previewing && <p className="overview-preview-label">开发预览 · 全部内容为虚构示例 · 未写入真实存储</p>}
    {!queryClient && <p className="reader-availability">请在桌面应用中查看已保存的会话。</p>}
    <PersonalOverview data={overview ?? { materialStatus: memories.length ? 'ready' : reader.conversations.length ? 'unanalysed' : 'none', discoveries: [], preferences }}
      conversationTitle={(activeSummary ?? reader.conversations[0])?.title}
      onOpenConversation={reader.conversations[0] ? () => openConversation(activeSummary?.id ?? reader.conversations[0].id, {origin:'overview'}) : undefined}
      onOpenMemory={memories[0] ? () => openLibrary(memories[0].id) : undefined}
      hasRelationshipObservations={contributions.length > 0}
      headingRef={overviewTitleRef} onReturnToCover={returnToCover} onImport={openImport}
      onOpenSource={openSource} isSourceAvailable={sourceAvailable}
      feedback={feedback}>
      <RelationshipObservations observations={contributions} onRead={openLibrary} />
    </PersonalOverview>
    {memoryError && <p role="alert">{memoryError} <button type="button" onClick={refreshMemories}>重试</button></p>}
  </>

  return (
    <><div style={{ ...navPane.style, display: settingsOpen ? 'none' : undefined }} className={clsx('app-shell', navPane.dragging && 'pane-resizing', open && 'sidebar-open', introActive && 'startup-running', window.whomi && !preview && 'desktop-shell')}>
      {window.whomi && !preview && view !== 'conversation' && <div className="desktop-drag-strip" aria-hidden="true" />}
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
          <Tooltip content="记忆仓库">
            <button className="nav-control" type="button" aria-label="记忆仓库" aria-current={view === 'library' ? 'page' : undefined} onClick={() => openLibrary()}>
              <span className="control-icon"><Archive aria-hidden="true" /></span><span className="control-label" aria-hidden="true">记忆仓库</span>
            </button>
          </Tooltip>
          <Tooltip content="问一问">
            <button className="nav-control" type="button" aria-label="问一问" aria-current={view === 'clarification' ? 'page' : undefined} onClick={openClarification}>
              <span className="control-icon"><MessageCircleQuestion aria-hidden="true" /></span>
              <span className="control-label" aria-hidden="true">问一问</span>
            </button>
          </Tooltip>
          <ConversationNavigation wide={open} conversations={reader.conversations} activeId={view === 'conversation' ? activeId : undefined}
            arrange={api?.arrangeConversation && (async change => { await api.arrangeConversation(change); await reader.refresh({ preserveReader: true }) })}
            remove={api?.deleteConversation && handleDeleteConversation}
            onImport={startNewImport} onSelect={openConversation} hasMore={!!reader.listCursor} loading={reader.listLoading}
            error={reader.listError} onLoadMore={() => { void reader.loadMore() }} onRefresh={() => { void reader.refresh() }} />
        </nav>
        <footer className="sidebar-footer">
          {api?.settings ? <button ref={settingsEntry} className="nav-control" type="button" aria-label="设置" onClick={() => { closeMobile(); setSettingsOpen(true) }}>
            <span className="control-icon"><Settings aria-hidden="true" /></span><span className="control-label" aria-hidden="true">设置</span>
          </button> : <UnavailableDestination label="设置" icon={Settings} />}
        </footer>
      </aside>
      <main id="main-content" ref={mainRef} className={clsx('home', view === 'cover' && 'cover-home', (view === 'overview' || view === 'clarification' || view === 'library') && 'overview-home', view === 'conversation' && 'reading-home')} tabIndex={-1} inert={mobileDialog || introActive}>
        {view === 'cover' ? <HelloCover key={coverKey} name={name} buttonRef={greetingRef} onEnter={enterOverview}><div className="hello-overview-outline"><strong>个人总览</strong><div>人格偏好</div>
            {['精力来源','理解信息','做决定','安排方式'].map(label => <p key={label}>{label}<i /></p>)}<div>Spark · 不一样的自己</div></div></HelloCover>
          : view === 'library' ? <MemoryLibrary entries={memories} selectedId={selectedMemory} onSelect={setSelectedMemory}
            unfinished={unfinished} conversations={reader.conversations} onStart={(id, taskId) => openConversation(id, { origin:'library', taskId })}
            onImport={startNewImport} hasMore={!!reader.listCursor} loadMore={() => { void reader.loadMore() }}
            listLoading={reader.listLoading} listError={reader.listError} retryList={() => { void reader.refresh() }}
            loading={memoryLoading} error={memoryError} retry={refreshMemories} />
          : view === 'import' ? <FileImport key={importKey} api={api} onSaved={saved} onOpenConversation={openConversation} />
          : view === 'conversation' && activeId && reader.current ? <ConversationReader
          key={`${activeId}-${source?.id ?? ''}`} conversation={{ id: activeId, title: activeSummary?.title ?? '会话', messages: reader.current.messages }}
          openAnalysisOnEntry={!!memoryEntry} initialAnalysisTaskId={memoryEntry?.taskId}
          range={reader.current.range} sourceStatus={reader.current.sourceStatus} loading={reader.loading} error={reader.error} preview={previewing}
          beforeCursor={reader.current.beforeCursor} afterCursor={reader.current.afterCursor}
          messageCount={activeSummary?.messageCount} aiAdapter={conversationAiAdapter ?? desktopAi}
          onLocateMessageId={id => reader.locate({ conversationId: activeId, messageId: id }, { preserveOnFailure: true })}
          onBefore={reader.loadBefore} onAfter={reader.loadAfter} onRetry={() => { void reader.open(activeId) }}
          onReturn={source ? (sourceOrigin === 'clarification' ? openClarification : enterOverview) : memoryEntry ? (memoryEntry.origin === 'library' ? () => openLibrary() : enterOverview) : fromImport ? openImport : undefined}
          returnLabel={memoryEntry?.origin === 'library' ? '返回记忆仓库' : fromImport ? '返回导入结果' : sourceOrigin === 'clarification' ? '返回问一问' : '返回个人总览'}
          api={api} onConfigureModels={api?.settings ? onReturn => { settingsReturn.current = onReturn; closeMobile(); setSettingsOpen(true) } : undefined} onOpenMemory={openLibrary} onDeleteConversation={handleDeleteConversation} onSelfChanged={() => {
            setTasks(entries => entries.map(entry => entry.conversationId === activeId ? { ...entry, valid: false } : entry))
            refreshMemories()
            void reader.open(activeId)
          }} /> : view === 'clarification' ? (
          <ClarificationPage question={clarificationQuestion} models={clarificationModels} controller={clarification}
            headingRef={clarificationTitleRef} preview={previewing} onReturn={leaveClarification} returnLabel={questionReturnLabel}
            onOpenSource={reference => openSource(reference, 'clarification')}
            isSourceAvailable={sourceAvailable} />
        ) : overviewContent}
      </main>
      {introActive && <StartupIntro targetRef={brandImageRef} onComplete={finishIntro} />}
    </div>{settingsOpen && api?.settings && <><div className="desktop-drag-strip settings-drag-strip" aria-hidden="true" /><SettingsPage api={api.settings} onChanged={() => { settingsChanged.current = true }} onClose={() => {
      setSettingsOpen(false)
      if (settingsChanged.current) { setSettingsRevision(value => value + 1); settingsChanged.current = false }
      const restore = settingsReturn.current
      settingsReturn.current = null
      requestAnimationFrame(restore ?? (() => settingsEntry.current?.focus()))
    }} /></>}</>
  )
}

export default function App(props: AppProps) {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={120}>
      <SidebarProvider><HomeShell {...props} /></SidebarProvider>
    </TooltipProvider>
  )
}
