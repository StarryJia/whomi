import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ArrowRight, ArrowLeft, Pause, Play, Box, Check, ChevronDown, FileText, LoaderCircle, MessageCircle, PanelLeft, Square, SquarePen, X } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import type { ReferenceRange } from './selection'
import type { ConversationAiAdapter, ConversationRequest, GenerationUsage } from './types'
import type { AnalysisPreparation, AiThreadSummary } from '../../shared/ai-contract'
import './workspace.css'
import './analysis-panel.css'
import { useAnalysisTask } from './use-analysis-task'
import { ConversationPopoverOwner, ModelSelector, ThinkingSelector, type ThinkingLevel, type ModelOption } from './model-selector'
import { messagePerformance } from './message-performance'
import { AnswerContent } from './answer-content'
import { usePaneDivider } from '../ui/pane-divider'
import { ManagedRow } from '../ui/managed-row'
import { MemoryArticle } from '../memory-library'
import { isMemoryReport } from '../../shared/memory'
import { AnswerActions } from './answer-actions'

const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
function seconds(ms: number | undefined) { return valid(ms) ? `${number(ms / 1000)} 秒` : '未提供' }
function errorText(error: unknown) { return error instanceof Error ? error.message : error && typeof error === 'object' && 'action' in error && typeof error.action === 'string' ? error.action : '操作失败，请重试。' }

function Popover({ anchor, label, children, onClose, above = false, alignStart = false, onMouseEnter, onMouseLeave, id, focusOnOpen }: {
  anchor: RefObject<HTMLElement | null>; label: string; children: ReactNode; onClose: () => void; above?: boolean; alignStart?: boolean
  onMouseEnter?: () => void; onMouseLeave?: () => void
  id?: string; focusOnOpen?: boolean
}) {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focusOnOpen) body.current?.focus({ preventScroll: true }) }, [focusOnOpen])
  const ownerId = useId()
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const place = () => {
      const target = anchor.current?.getBoundingClientRect()
      const rect = body.current?.getBoundingClientRect()
      if (!target || !rect) return
      const fitsAbove = target.top - rect.height - 8 >= 8
      const top = (above && fitsAbove) || target.bottom + rect.height + 8 > window.innerHeight
        ? target.top - rect.height - 8 : target.bottom + 8
      setPosition({ top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)),
        left: Math.max(8, Math.min(alignStart ? target.left : target.right - rect.width, window.innerWidth - rect.width - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const resize = new ResizeObserver(place)
    if (body.current) resize.observe(body.current)
    const outside = (event: PointerEvent) => {
      if (event.composedPath().some(node => node instanceof HTMLElement && (node.matches('dialog[open]') || node.dataset.conversationPopoverOwner === ownerId))) return
      if (!body.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.composedPath().some(node => node instanceof HTMLElement && (node.matches('dialog[open]') || node.dataset.conversationPopoverOwner === ownerId))) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
      anchor.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      resize.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [anchor, above, alignStart, ownerId])
  return createPortal(<ConversationPopoverOwner.Provider value={ownerId}><div id={id} ref={body} tabIndex={focusOnOpen ? -1 : undefined} className="conversation-popover" role="region" aria-label={label}
    style={position} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>{children}</div></ConversationPopoverOwner.Provider>, document.body)
}

function References({ references, savedIds, onJump, onClear, onRemove }: {
  references: readonly ReferenceRange[]; savedIds?: readonly string[]
  onJump: (ids: readonly string[], targetId?: string) => void; onClear?: () => void; onRemove?: (id: string) => void
}) {
  const [open, setOpen] = useState<'hover' | 'pinned' | false>(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const clearButton = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keep = () => { clearTimeout(timer.current); setOpen(current => current || 'hover') }
  const leave = () => { timer.current = setTimeout(() => setOpen(current => current === 'hover' ? false : current), 180) }
  useEffect(() => () => clearTimeout(timer.current), [])
  const ids = savedIds?.length ? savedIds : references.flatMap(range => range.messages.map(message => message.id))
  const count = onClear ? references.length : ids.length
  if (!count) return null
  if (!references.length) return <button type="button" className="conversation-reference-chip" onClick={() => onJump(ids)}>
    <FileText aria-hidden="true" />{count} 条引用</button>
  return <div className="conversation-references" onMouseEnter={keep} onMouseLeave={leave}>
    <button ref={anchor} type="button" className="conversation-reference-chip" aria-expanded={!!open}
      aria-controls={open ? popoverId : undefined} onKeyDown={event => {
        if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey && open)) {
          event.preventDefault()
          setOpen('pinned')
          requestAnimationFrame(() => list.current?.querySelector('button')?.focus())
        }
      }} onClick={() => {
        if (onClear) setOpen(current => current === 'pinned' ? false : 'pinned')
        else { setOpen(false); onJump(ids) }
      }}>
      <FileText aria-hidden="true" />{count} {onClear ? '组引用' : '条引用'}<ChevronDown aria-hidden="true" />
    </button>
    {onClear && <button ref={clearButton} type="button" className="conversation-icon-button" aria-label="清空全部引用" title="清空全部引用" onClick={onClear}><X aria-hidden="true" /></button>}
    {open && <Popover id={popoverId} anchor={anchor} above alignStart={!!onClear} label="引用预览" onClose={() => setOpen(false)} onMouseEnter={keep} onMouseLeave={leave}>
      <div ref={list} className="conversation-reference-list" onKeyDown={event => {
        if (event.key !== 'Tab') return
        const buttons = event.currentTarget.querySelectorAll('button')
        if (event.target !== (event.shiftKey ? buttons[0] : buttons[buttons.length - 1])) return
        event.preventDefault()
        setOpen(false)
        const next = event.shiftKey ? anchor.current : clearButton.current ?? anchor.current
        next?.focus()
      }}>{references.map((reference, index) => {
        const first = reference.messages[0]
        const removeLabel = `移除第 ${index + 1} 组引用`
        return <div key={reference.id} className="conversation-reference-row">
          <button type="button" className="conversation-reference-jump" onClick={() => { setOpen(false); onJump(ids, first?.id) }}>
            <FileText aria-hidden="true" /><span><strong>引用 {index + 1} · {first?.senderName ?? '消息'}</strong>
            <span className="conversation-reference-summary"><span>{first?.text || '查看原文'}</span><small>· 共 {reference.messages.length} 条消息</small></span></span>
          </button>
          {onRemove && <button type="button" className="conversation-icon-button conversation-reference-remove" aria-label={removeLabel} title={removeLabel} onClick={() => {
            const buttons = list.current?.querySelectorAll<HTMLButtonElement>('.conversation-reference-remove')
            const neighbor = buttons?.[index + 1] ?? buttons?.[index - 1]
            neighbor?.focus({ preventScroll: true })
            setOpen(neighbor ? 'pinned' : false)
            onRemove(reference.id)
          }}><X aria-hidden="true" /></button>}
        </div>
      })}</div>
    </Popover>}
  </div>
}

function Usage({ usage, model }: { usage?: GenerationUsage; model?: ModelOption }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!usage || ![usage.inputTokens, usage.outputTokens, usage.totalInputTokens, usage.durationMs].some(valid)) return null
  const performance = messagePerformance(usage)
  const tokens = (value?: number) => valid(value) ? `${number(value)} Tokens` : '—'
  const speed = (value?: number) => valid(value) ? `${number(value)} Token/秒` : '—'
  return <div className="conversation-usage">
    <button ref={anchor} type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {valid(usage.outputTokens) && <span>输出 {number(usage.outputTokens)} token</span>}
      {valid(performance.modelTokensPerSecond) && <span>{number(performance.modelTokensPerSecond)} token/秒</span>}
      {!valid(usage.outputTokens) && !valid(performance.modelTokensPerSecond) && '生成统计'}
      <ChevronDown aria-hidden="true" />
    </button>
    {open && <Popover anchor={anchor} above label="生成统计" onClose={() => setOpen(false)}>
      <div className="cherry-usage-identity"><Box aria-hidden="true" /><div><strong>{model?.label ?? '模型'}</strong>
        {model?.model && <span>{model.model}</span>}</div>
        <time>{usage.completedAt ? new Date(usage.completedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</time>
      </div>
      <dl className="conversation-usage-grid cherry-usage-primary">
        <div><dt>输入</dt><dd title={tokens(performance.inputTokens)}>{tokens(performance.inputTokens)}</dd></div>
        <div><dt>输出</dt><dd title={tokens(usage.outputTokens)}>{tokens(usage.outputTokens)}</dd></div>
        <div><dt>模型生成 TPS</dt><dd title={speed(performance.modelTokensPerSecond)}>{speed(performance.modelTokensPerSecond)}</dd></div>
      </dl><dl className="cherry-usage-details">
        {valid(usage.cacheReadTokens) && usage.cacheReadTokens > 0 && <div><dt>缓存读取</dt><dd>{tokens(usage.cacheReadTokens)}</dd></div>}
        {valid(usage.cacheWriteTokens) && usage.cacheWriteTokens > 0 && <div><dt>缓存写入</dt><dd>{tokens(usage.cacheWriteTokens)}</dd></div>}
        <div><dt>未缓存</dt><dd>{tokens(performance.uncachedTokens)}</dd></div>
        <div><dt>首 Token 耗时</dt><dd>{valid(usage.firstTokenMs) ? seconds(usage.firstTokenMs) : '—'}</dd></div>
        <div><dt>端到端吞吐</dt><dd>{speed(performance.endToEndTokensPerSecond)}</dd></div>
        <div><dt>端到端耗时</dt><dd>{valid(usage.durationMs) ? seconds(usage.durationMs) : '—'}</dd></div>
      </dl>
    </Popover>}
  </div>
}

type Turn = { id: number | string; request: ConversationRequest; modelIdentity?: ModelOption; referenceIds?: string[]; text: string; usage?: GenerationUsage; status: 'running' | 'done' | 'failed' | 'stopped'; error?: string; remote?: boolean }
const turnModel = (turn: Turn): ModelOption => turn.modelIdentity ?? { id: turn.request.modelId, label: '未知模型' }
type Slots = { analysisControl: ReactNode; chatControl: ReactNode; composer: ReactNode; panelOpen: boolean }
export function ConversationWorkspace({ conversationId, initialAnalysisTaskId, openAnalysisOnEntry = false, identityRevision = 0, title, messageCount, references, onClearReferences, onRestoreReferences, onJumpReference, onOpenAnalysisResult, onConfigureModels, adapter, children }: {
  conversationId: string; identityRevision?: number; title: string; messageCount?: number; references: readonly ReferenceRange[]
  onClearReferences: () => void; onJumpReference: (ids: readonly string[], targetId?: string, pending?: boolean) => void
  onRestoreReferences?: (references: readonly ReferenceRange[]) => void
  onConfigureModels?: (onReturn: () => void) => void
  openAnalysisOnEntry?: boolean; initialAnalysisTaskId?: string
  onOpenAnalysisResult?: (taskId: string) => void
  adapter?: ConversationAiAdapter; children: (slots: Slots) => ReactNode
}) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [threadId, setThreadId] = useState<string>()
  const [threads, setThreads] = useState<AiThreadSummary[]>([])
  const [threadListOpen, setThreadListOpen] = useState(false)
  const [threadListLoading, setThreadListLoading] = useState(false)
  const [threadListError, setThreadListError] = useState('')
  const [threadCreating, setThreadCreating] = useState(false)
  const creatingThread = useRef(false)
  const [threadListAttempt, setThreadListAttempt] = useState(0)
  const activeThread = useRef<string | undefined>(undefined)
  const threadDrafts = useRef(new Map<string, string>())
  const threadTurns = useRef(new Map<string, Turn[]>())
  const threadReferences = useRef(new Map<string, readonly ReferenceRange[]>())
  const threadScrolls = useRef(new Map<string, { top: number; atEnd: boolean }>())
  const pendingScroll = useRef<{ top: number; atEnd: boolean } | undefined>(undefined)
  const initialModel = (feature: 'analysis' | 'conversation') => adapter?.selectedModels ? adapter.selectedModels[feature] ?? '' : adapter?.models[0]?.id ?? ''
  const [modelId, setModelId] = useState(initialModel('conversation'))
  const [analysisModelId, setAnalysisModelId] = useState(initialModel('analysis'))
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>()
  const [analysisThinkingLevel, setAnalysisThinkingLevel] = useState<ThinkingLevel>()
  const [modelErrors, setModelErrors] = useState<Partial<Record<'analysis' | 'conversation', string>>>({})
  const [modelSaving, setModelSaving] = useState<Partial<Record<'analysis' | 'conversation', boolean>>>({})
  const [skillId, setSkillId] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const latestDraft = useRef(draft)
  const latestTurns = useRef(turns)
  const latestReferences = useRef(references)
  latestDraft.current = draft
  latestTurns.current = turns
  latestReferences.current = references
  const [busy, setBusy] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(openAnalysisOnEntry)
  const analysis = useAnalysisTask(adapter, conversationId, identityRevision, initialAnalysisTaskId, openAnalysisOnEntry)
  const { confirming: analysisConfirming, setConfirming: setAnalysisConfirming, phase: analysisState,
    error: analysisError, setError: setAnalysisError, progress, result: analysisResult } = analysis
  const [showReport, setShowReport] = useState(false)
  const [preparation, setPreparation] = useState<AnalysisPreparation>()
  const [preparing, setPreparing] = useState(false)
  const [prepareAttempt, setPrepareAttempt] = useState(0)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1000px)').matches)
  const chatPane = usePaneDivider('assistant', panelOpen && !narrow)
  const source = useRef<HTMLDivElement>(null)
  const aside = useRef<HTMLElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const analysisAnchor = useRef<HTMLButtonElement>(null)
  const chatAnchor = useRef<HTMLButtonElement>(null)
  const historyAnchor = useRef<HTMLButtonElement>(null)
  const chatRun = useRef<AbortController | undefined>(undefined)
  const sequence = useRef(0)
  const alive = useRef(true)
  const selectionGeneration = useRef({ analysis: 0, conversation: 0 })
  const panelId = useId()
  const draftId = useId()
  const scroll = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const selectedModel = adapter?.models.find(model => model.id === modelId)
  const selectedAnalysisModel = adapter?.models.find(model => model.id === analysisModelId)
  const effectiveThinkingLevel = thinkingLevel && selectedModel?.thinkingLevels?.includes(thinkingLevel) ? thinkingLevel : undefined
  const effectiveAnalysisThinkingLevel = analysisThinkingLevel && selectedAnalysisModel?.thinkingLevels?.includes(analysisThinkingLevel) ? analysisThinkingLevel : undefined
  async function chooseModel(feature: 'analysis' | 'conversation', id: string) {
    const generation = ++selectionGeneration.current[feature]
    setModelErrors(current => ({ ...current, [feature]: '' }))
    setModelSaving(current => ({ ...current, [feature]: true }))
    try {
      await adapter?.selectModel?.(feature, id || null)
      if (selectionGeneration.current[feature] !== generation) return
      if (feature === 'analysis') { setAnalysisModelId(id); setAnalysisThinkingLevel(undefined) } else { setModelId(id); setThinkingLevel(undefined) }
    } catch (error) { if (selectionGeneration.current[feature] === generation) setModelErrors(current => ({ ...current, [feature]: errorText(error) })) }
    finally { if (selectionGeneration.current[feature] === generation) setModelSaving(current => ({ ...current, [feature]: false })) }
  }
  const canSend = !!adapter && !!selectedModel && !!draft.trim() && !busy && !restoring && !threadCreating && !threadListLoading && !threadListError && !modelSaving.conversation

  function activateThread(id: string | undefined, keepDraft = false) {
    threadDrafts.current.set(activeThread.current ?? 'initial', latestDraft.current)
    threadTurns.current.set(activeThread.current ?? 'initial', latestTurns.current)
    threadReferences.current.set(activeThread.current ?? 'initial', latestReferences.current)
    threadScrolls.current.set(activeThread.current ?? 'initial', { top: scroll.current?.scrollTop ?? 0, atEnd: atEnd.current })
    chatRun.current?.abort('detach')
    chatRun.current = undefined
    activeThread.current = id
    setThreadId(id)
    if (!keepDraft) {
      setDraft(threadDrafts.current.get(id ?? '') ?? '')
      setTurns(threadTurns.current.get(id ?? '') ?? [])
    }
    setBusy(false)
    setRestoring(false)
    setRestoreError('')
    pendingScroll.current = threadScrolls.current.get(id ?? '') ?? { top: 0, atEnd: true }
    atEnd.current = pendingScroll.current.atEnd
    if (!keepDraft) {
      if (onRestoreReferences) onRestoreReferences(threadReferences.current.get(id ?? '') ?? [])
      else onClearReferences()
    }
  }
  function focusThreadEditor() {
    setThreadListOpen(false)
    requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }))
  }
  async function newThread(keepDraft = false) {
    if (!adapter?.createThread || creatingThread.current || restoring || threadListLoading) return
    const origin = activeThread.current
    if (origin && latestTurns.current.length === 0 && !restoreError) {
      focusThreadEditor()
      return origin
    }
    creatingThread.current = true
    setThreadCreating(true)
    setThreadListError('')
    try {
      const created = await adapter.createThread(conversationId)
      if (!alive.current) return
      setThreads(items => [...items.filter(item => item.pinned), created, ...items.filter(item => !item.pinned && item.id !== created.id)])
      if (activeThread.current !== origin) return
      activateThread(created.id, keepDraft || (!origin && latestTurns.current.length === 0))
      focusThreadEditor()
      return created.id
    } catch (error) { if (keepDraft) throw error; if (alive.current) setThreadListError(errorText(error)) }
    finally { creatingThread.current = false; if (alive.current) setThreadCreating(false) }
  }

  useEffect(() => {
    if (!panelOpen || !adapter?.listThreads) return
    let current = true
    setThreadListLoading(true)
    setThreadListError('')
    void adapter.listThreads(conversationId).then(items => {
      if (!current) return
      setThreads(items)
      if (!activeThread.current && items[0]) {
        activeThread.current = items[0].id
        setThreadId(items[0].id)
      }
    }, error => { if (current) setThreadListError(errorText(error)) }).finally(() => { if (current) setThreadListLoading(false) })
    return () => { current = false }
  }, [adapter, conversationId, panelOpen, threadListAttempt])

  useEffect(() => {
    alive.current = true
    setModelId(initialModel('conversation'))
    setAnalysisModelId(initialModel('analysis'))
    setModelErrors({})
    setModelSaving({})
    setBusy(false)
    setTurns(items => items.map(turn => turn.status === 'running' ? { ...turn, status: 'stopped' } : turn))
    setShowReport(false)
    return () => {
      alive.current = false
      selectionGeneration.current.analysis++
      selectionGeneration.current.conversation++
      chatRun.current?.abort('detach')
      chatRun.current = undefined
    }
  }, [conversationId, adapter])
  useEffect(() => {
    if (!adapter?.watchThread && !adapter?.restoreThread) return
    if (adapter.listThreads && !threadId) return
    const controller = new AbortController()
    setRestoring(true)
    setRestoreError('')
    const receive: Parameters<NonNullable<ConversationAiAdapter['watchThread']>>[1] = values => {
      if (controller.signal.aborted || (threadId && activeThread.current !== threadId)) return
      setRestoring(false)
      setTurns(previous => {
        const restored: Turn[] = values.map(value => {
          const existing = previous.find(turn => turn.request.requestId === value.requestId)
          return { id: value.id, remote: true, request: { conversationId, threadId, turnId: value.id, referenceIds: value.referenceIds, requestId: value.requestId, prompt: value.prompt,
            modelId: value.modelId, thinkingLevel: value.thinkingLevel, skillId: value.skillId, references: existing?.request.references ?? [] },
            modelIdentity: value.modelIdentity, referenceIds: value.referenceIds, text: value.text, usage: value.usage, error: value.error,
            status: ['queued', 'running', 'summarizing'].includes(value.state) ? 'running' : value.state === 'completed' ? 'done' : value.state === 'stopped' ? 'stopped' : 'failed' }
        })
        return [...restored, ...previous.filter(turn => !turn.remote && !values.some(value => value.requestId === turn.request.requestId))]
      })
      setBusy(values.some(turn => ['queued', 'running', 'summarizing'].includes(turn.state)) || !!chatRun.current)
    }
    const work = adapter.watchThread ? adapter.watchThread(conversationId, receive, controller.signal, threadId)
      : adapter.restoreThread!(conversationId, threadId).then(receive)
    void work.catch(error => { if (!controller.signal.aborted) { setRestoring(false); setRestoreError(errorText(error)) } })
    return () => controller.abort('detach')
  }, [adapter, conversationId, threadId])
  useEffect(() => {
    if (!analysisOpen || !analysisConfirming || !adapter?.prepareAnalysis || !selectedAnalysisModel) return
    let current = true
    setPreparing(true)
    setPreparation(undefined)
    setAnalysisError('')
    void adapter.prepareAnalysis({ conversationId, modelId: analysisModelId, ...(effectiveAnalysisThinkingLevel ? { thinkingLevel: effectiveAnalysisThinkingLevel } : {}) }).then(value => {
      if (current) setPreparation(value)
    }, error => { if (current) setAnalysisError(errorText(error)) }).finally(() => { if (current) setPreparing(false) })
    return () => { current = false }
  }, [analysisOpen, analysisConfirming, adapter, conversationId, identityRevision, analysisModelId, effectiveAnalysisThinkingLevel, selectedAnalysisModel, prepareAttempt])
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1000px)')
    const update = () => { setNarrow(query.matches); if (query.matches) setThreadListOpen(false) }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    if (panelOpen) textarea.current?.focus({ preventScroll: true })
  }, [panelOpen])
  useLayoutEffect(() => {
    if (!scroll.current) return
    if (pendingScroll.current) {
      scroll.current.scrollTop = pendingScroll.current.atEnd ? scroll.current.scrollHeight : pendingScroll.current.top
      pendingScroll.current = undefined
    } else if (atEnd.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [turns])
  useLayoutEffect(() => {
    // 流式排版异步提交正文，按真实内容高度跟随末尾。
    const observer = new ResizeObserver(() => {
      if (atEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
    })
    if (transcript.current) observer.observe(transcript.current)
    return () => observer.disconnect()
  }, [])
  function closePanel() {
    setPanelOpen(false)
    requestAnimationFrame(() => {
      chatAnchor.current?.focus()
    })
  }
  function jump(ids: readonly string[], targetId?: string, pending = false) {
    if (narrow) setPanelOpen(false)
    onJumpReference(ids, targetId, pending)
  }
  function stopChat() {
    chatRun.current?.abort()
    chatRun.current = undefined
    setBusy(false)
    setTurns(items => items.map(turn => turn.status === 'running' ? { ...turn, status: 'stopped' } : turn))
    const running = turns.find(turn => turn.remote && turn.status === 'running')
    if (running) void adapter?.stopTurn?.(String(running.id)).catch(error => setRestoreError(errorText(error)))
  }
  async function send(retry?: Turn) {
    if (!adapter || busy || chatRun.current || (!retry && !canSend)) return
    const request: ConversationRequest = retry?.request ?? { requestId: crypto.randomUUID(), conversationId, threadId, prompt: draft.trim(),
      references: references.map(reference => ({ ...reference, messages: [...reference.messages] })), modelId, ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      history: turns.filter(turn => turn.status === 'done').flatMap(turn => [
        { role: 'user' as const, text: turn.request.prompt, references: turn.request.references },
        { role: 'assistant' as const, text: turn.text },
      ]),
      ...(references.length && adapter.skills.some(skill => skill.id === skillId) ? { skillId } : {}) }
    const id = retry?.id ?? ++sequence.current
    const modelIdentity = retry ? retry.modelIdentity : selectedModel ? { id: selectedModel.id, label: selectedModel.label, model: selectedModel.model, version: selectedModel.version } : undefined
    if (!retry) { latestDraft.current = ''; setDraft(''); onClearReferences() }
    let targetThread = request.threadId
    try {
      targetThread ??= adapter.createThread ? await newThread(true) : undefined
      if (!alive.current || (adapter.createThread && !targetThread)) return
      request.threadId = targetThread
    } catch (error) {
      if (alive.current) setTurns(items => {
        const failed: Turn = { id, request, modelIdentity, text: '', status: 'failed', error: errorText(error) }
        return retry ? items.map(item => item.id === id ? failed : item) : [...items, failed]
      })
      return
    }
    const controller = new AbortController()
    chatRun.current = controller
    setPanelOpen(true)
    setBusy(true)
    atEnd.current = true
    const next: Turn = { id, request, modelIdentity, text: '', status: 'running' }
    setTurns(items => retry ? items.map(item => item.id === id ? next : item) : [...items, next])
    if (targetThread && !retry) setThreads(items => items.map(item => item.id === targetThread && item.title === '新对话'
      ? { ...item, title: Array.from(request.prompt.replace(/\s+/g, ' ')).slice(0, 40).join('') } : item))
    const active = () => alive.current && chatRun.current === controller && !controller.signal.aborted
    try {
      const result = await adapter.respond(request, { signal: controller.signal, onText: text => {
        if (active()) setTurns(items => items.map(item => item.id === id ? { ...item, text } : item))
      } })
      if (!active()) return
      if (!result.text.trim()) throw new Error('未收到回答，请重试。')
      setTurns(items => items.map(item => item.id === id || item.request.requestId === request.requestId ? { ...item, modelIdentity: result.modelIdentity ?? item.modelIdentity, text: result.text, usage: result.usage, status: 'done' } : item))
    } catch (error) {
      if (active()) setTurns(items => items.map(item => item.id === id ? { ...item, status: 'failed', error: errorText(error) } : item))
    } finally {
      if (active()) { chatRun.current = undefined; setBusy(false) }
    }
  }
  function analyze() {
    if (!selectedAnalysisModel || modelSaving.analysis || preparing || (adapter?.prepareAnalysis && !preparation)) return
    void analysis.run({ conversationId, modelId: analysisModelId, ...(effectiveAnalysisThinkingLevel ? { thinkingLevel: effectiveAnalysisThinkingLevel } : {}),
      ...(preparation ? { preparationToken: preparation.token, requestId: crypto.randomUUID() } : {}) })
  }
  const completed = valid(progress?.analyzedMessages) ? progress.analyzedMessages : 0
  const total = valid(progress?.totalMessages) ? progress.totalMessages : messageCount
  const percentage = valid(total) && total > 0 ? Math.min(100, completed / total * 100) : undefined
  const percentText = percentage === undefined ? undefined : percentage > 0 && percentage < 1 ? '<1%'
    : percentage > 99 && percentage < 100 ? '>99%' : Math.round(percentage) + '%'
  const analysisUsage = analysisResult?.usage ?? progress?.usage
  const analysisSpeed = analysisUsage?.outputTokensPerSecond ?? progress?.outputTokensPerSecond
  const hasAnalysisUsage = analysisUsage && Object.values(analysisUsage).some(valid)
  const confirmAnalysis = () => { setPreparation(undefined); setAnalysisConfirming(true); setAnalysisError(''); setPrepareAttempt(value => value + 1) }
  const activeTask = progress?.task
  const pauseSupported = !!adapter?.continueAnalysis
  const waitingForStart = analysisState === 'running' && pauseSupported &&
    (!activeTask || !['queued', 'running', 'summarizing'].includes(activeTask.state))
  const report = analysisResult?.task?.report
  const titles = {
    idle: '整理成记忆', running: '正在整理', done: '记忆已生成', interrupted: '生成中断',
    stopped: pauseSupported ? '生成已暂停' : '已停止', failed: '生成失败',
  }
  let statusTitle = titles[analysisState]
  if (analysis.stopping) statusTitle = '正在暂停'
  else if (waitingForStart) statusTitle = '正在准备生成'
  else if (analysisState === 'running' && activeTask?.state === 'summarizing') statusTitle = '正在撰写记忆'
  const closeAnalysis = () => {
    setAnalysisOpen(false); setShowReport(false)
    if (analysisState !== 'idle') setAnalysisConfirming(false)
    analysisAnchor.current?.focus()
  }
  function configureModels(fromAnalysis: boolean) {
    if (!onConfigureModels) return
    if (fromAnalysis) setAnalysisOpen(false)
    onConfigureModels(() => {
      if (!alive.current) return
      if (fromAnalysis) { confirmAnalysis(); setAnalysisOpen(true) }
      else textarea.current?.focus({ preventScroll: true })
    })
  }
  const coverageDescription = progress && valid(total) ? `${statusTitle}，已整理 ${number(completed)} / ${number(total)} 条` : statusTitle
  const analysisControl = <>
    <button ref={analysisAnchor} type="button" className="conversation-analysis-trigger" aria-expanded={analysisOpen} aria-description={coverageDescription} title={coverageDescription}
      onClick={() => analysisOpen ? closeAnalysis() : setAnalysisOpen(true)}>
       {analysisState === 'done' ? <Check aria-hidden="true" /> : <svg className="memory-coverage-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="memory-ring-track" cx="12" cy="12" r="9" />
        <circle className="memory-ring-value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percentage ?? 0} 100`} transform="rotate(-90 12 12)" />
      </svg>}整理成记忆
    </button>
    {analysisOpen && <Popover anchor={analysisAnchor} focusOnOpen label="记忆生成状态" onClose={closeAnalysis}>
      <section className="analysis-sheet">
        {showReport && report ? <>
          <h3 tabIndex={-1} ref={element => { element?.focus({ preventScroll: true }) }}>{isMemoryReport(report) ? '我们的记忆' : '分析报告'}</h3>
          <MemoryArticle report={report} />
          <footer><button type="button" className="analysis-secondary" onClick={() => setShowReport(false)}><ArrowLeft aria-hidden="true" />返回进度</button></footer>
        </> : analysisConfirming ? <>
          <h3>整理成记忆</h3>
          <p className="analysis-description">{preparation?.title ?? title}{(preparation?.analyzableMessages ?? messageCount) !== undefined && ` · ${number(preparation?.analyzableMessages ?? messageCount!)} 条消息`}</p>
          {!!adapter?.models.length && <div className="analysis-model-row">
            <span>分析模型</span>
            <ModelSelector label="分析模型" models={adapter.models} value={selectedAnalysisModel?.id ?? ''}
              disabled={modelSaving.analysis} describedBy={modelErrors.analysis ? `${panelId}-analysis-model-error` : undefined}
              onSelect={id => { void chooseModel('analysis', id) }} />
            <ThinkingSelector levels={selectedAnalysisModel?.thinkingLevels} value={analysisThinkingLevel} onSelect={setAnalysisThinkingLevel} disabled={modelSaving.analysis || !selectedAnalysisModel} />
          </div>}
          {modelErrors.analysis && <p id={`${panelId}-analysis-model-error`} role="alert" className="conversation-error">{modelErrors.analysis}</p>}
          {preparing && <p role="status" className="analysis-notice">正在核对分析范围…</p>}
          {messageCount === 0 && !adapter?.prepareAnalysis ? <p className="analysis-notice">请先导入聊天记录。</p>
            : !selectedAnalysisModel && <p className="analysis-notice">{adapter?.models.length ? '请选择分析模型。' : onConfigureModels ? '选择模型后即可整理这段聊天。' : '请在设置中添加模型。'}</p>}
          {analysisError && <p role="alert" className="conversation-error">{analysisError}</p>}
          <footer>
            <button type="button" className="analysis-secondary" onClick={closeAnalysis}>取消</button>
            {!adapter?.models.length && onConfigureModels && <button type="button" className="analysis-primary" onClick={() => configureModels(true)}>配置模型</button>}
            {selectedAnalysisModel && (adapter?.prepareAnalysis ? !!preparation : messageCount !== 0) &&
              <button type="button" disabled={preparing || modelSaving.analysis} className="analysis-primary" onClick={analyze}>生成记忆<ArrowRight aria-hidden="true" /></button>}
            {selectedAnalysisModel && adapter?.prepareAnalysis && !preparing && !preparation &&
              <button type="button" className="analysis-primary" onClick={confirmAnalysis}>重新核对</button>}
          </footer>
        </> : <>
          <h3><span role="status">{statusTitle}</span></h3>
          <div className="analysis-meter">
            <div className="analysis-meter-values"><span>{progress ? `已整理 ${number(completed)} / ${number(progress.totalMessages)} 条` : valid(total) ? `当前会话 ${number(total)} 条消息` : '等待消息总数'}</span>
              {percentText && <strong>{percentText}</strong>}</div>
            <div role="progressbar" aria-label="记忆生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}
              className="analysis-track"><span style={{ width: `${percentage ?? 0}%` }} /></div>
          </div>
          {analysis.resumable && <p className="analysis-notice">{completed > 0 && completed === total ? '继续撰写文稿。'
            : completed > 0 ? '从已保存的进度继续。' : '继续时从首批消息开始。'}</p>}
          {hasAnalysisUsage ? <dl className="analysis-usage" role="group" aria-label="分析用量">
            <div><dt>输入 token</dt><dd>{valid(analysisUsage.inputTokens) ? number(analysisUsage.inputTokens) : '未提供'}</dd></div>
            <div><dt>输出 token</dt><dd>{valid(analysisUsage.outputTokens) ? number(analysisUsage.outputTokens) : '未提供'}</dd></div>
            <div><dt>总耗时</dt><dd>{seconds(analysisUsage.durationMs)}</dd></div>
          </dl> : analysisState === 'done' && <p className="analysis-notice">未提供用量统计。</p>}
          {valid(analysisSpeed) && <p className="analysis-notice">生成速度 {number(analysisSpeed)} token/秒</p>}
          {analysisError && <p role="alert" className="conversation-error">{analysisError}</p>}
          <footer>{analysisState === 'running'
            ? <button type="button" disabled={analysis.stopping || waitingForStart} className="analysis-secondary" onClick={() => { void analysis.stop() }}>
                {pauseSupported ? <Pause aria-hidden="true" /> : <Square aria-hidden="true" />}{pauseSupported ? '暂停生成' : '停止生成'}</button>
            : <button type="button" disabled={analysis.stopping} className="analysis-secondary" onClick={confirmAnalysis}>{analysisState === 'failed' && !activeTask ? '重试生成' : '重新生成'}</button>}
            {analysis.resumable && <button className="analysis-primary" type="button" disabled={analysis.stopping} onClick={() => { void analysis.run() }}><Play aria-hidden="true" />继续生成</button>}
            {analysisState === 'done' && analysisResult?.taskId && (report || onOpenAnalysisResult) &&
              <button type="button" className="analysis-primary" onClick={() => {
                if (onOpenAnalysisResult) onOpenAnalysisResult(analysisResult.taskId!)
                else setShowReport(true)
              }}>查看记忆<ArrowRight aria-hidden="true" /></button>}
          </footer>
          {analysisState === 'done' && onOpenAnalysisResult && !analysisResult?.taskId && <p className="analysis-notice">未找到成稿。</p>}
        </>}
      </section>
    </Popover>}
  </>
  function clearDraftReferences() {
    onClearReferences()
    textarea.current?.focus({ preventScroll: true })
  }
  const referenceControl = references.length > 0 && <References references={references}
    onJump={(ids, targetId) => jump(ids, targetId, true)} onClear={clearDraftReferences}
    onRemove={onRestoreReferences && (id => {
      const remaining = references.filter(range => range.id !== id)
      if (remaining.length) onRestoreReferences(remaining)
      else clearDraftReferences()
    })} />
  const editor = <form className="conversation-composer" onSubmit={event => { event.preventDefault(); void send() }}>
    <label htmlFor={draftId} className="visually-hidden">向 AI 提问</label>
    <textarea id={draftId} ref={textarea} rows={2} value={draft} placeholder="输入消息…"
      onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) void send() }
      }} />
    <div className="conversation-composer-tools">
      {!adapter?.models.length && onConfigureModels ? <button className="cherry-model-trigger" type="button" onClick={() => configureModels(false)}><Box aria-hidden="true" />配置模型</button> : <ModelSelector label="对话模型" models={adapter?.models ?? []} value={selectedModel?.id ?? ''} disabled={busy || modelSaving.conversation}
        describedBy={modelErrors.conversation ? `${panelId}-conversation-model-error` : undefined} onSelect={id => { void chooseModel('conversation', id) }} />}
      {selectedModel && <ThinkingSelector levels={selectedModel.thinkingLevels} value={thinkingLevel} onSelect={setThinkingLevel} disabled={busy || modelSaving.conversation} />}
      {references.length > 0 && !!adapter?.skills.length && <Select.Root value={skillId || 'default'} onValueChange={value => setSkillId(value === 'default' ? '' : value)} disabled={busy}>
        <Select.Trigger aria-label="对话技能" className="cherry-model-trigger cherry-skill-trigger"><FileText aria-hidden="true" /><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger>
        <Select.Portal><Select.Content className="cherry-skill-menu" position="popper" side="top" sideOffset={8} onEscapeKeyDown={event => event.stopPropagation()}><Select.Viewport>
          {[{ id: 'default', label: '默认方式' }, ...adapter.skills].map(skill => <Select.Item className="cherry-skill-option" value={skill.id} key={skill.id}><Select.ItemText>{skill.label}</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>)}
        </Select.Viewport></Select.Content></Select.Portal>
      </Select.Root>}
      <div className="conversation-send-tools">
        {busy ? <button type="button" className="conversation-send" aria-label="停止回答" onClick={stopChat}><Square aria-hidden="true" /></button>
          : <button type="submit" className="conversation-send" aria-label="发送给 AI" disabled={!canSend}>{threadCreating ? <LoaderCircle className="conversation-working" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}</button>}
      </div>
    </div>
    {modelErrors.conversation && <p id={`${panelId}-conversation-model-error`} role="alert" className="conversation-error">{modelErrors.conversation}</p>}
  </form>
  const chatControl = <button ref={chatAnchor} type="button" className="conversation-analysis-trigger conversation-chat-trigger" aria-expanded={panelOpen} aria-controls={panelId}
    aria-label="AI 对话" title="AI 对话" onClick={() => setPanelOpen(true)}><MessageCircle aria-hidden="true" /><span>AI 对话</span></button>
  return <div style={chatPane.style} className={`conversation-workspace${chatPane.dragging ? ' pane-resizing' : ''}${panelOpen ? ' has-ai-panel' : ''}`}>
    <div ref={source} className="conversation-source" inert={panelOpen && narrow}>{children({ analysisControl, chatControl, composer: null, panelOpen })}</div>
    <aside ref={aside} id={panelId} className="conversation-ai-panel" aria-label="AI 对话" role="complementary"
      inert={!panelOpen} aria-hidden={!panelOpen} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (threadListOpen) { setThreadListOpen(false); historyAnchor.current?.focus() }
          else closePanel()
        }
      }}>
      {panelOpen && !narrow && chatPane.divider}
      <header className="conversation-ai-header"><button ref={historyAnchor} type="button" className="conversation-icon-button" aria-label={threadListOpen ? '收起对话列表' : '显示对话列表'} aria-expanded={threadListOpen} onClick={() => setThreadListOpen(value => !value)}><PanelLeft aria-hidden="true" /></button>
        <h2>AI 对话</h2><button type="button" className="conversation-icon-button" aria-label="新建 AI 对话" title="新建 AI 对话" disabled={!adapter?.createThread || threadCreating || threadListLoading || restoring} onClick={() => { void newThread() }}><SquarePen aria-hidden="true" /></button>
        <button type="button" className="conversation-icon-button" aria-label="关闭 AI 对话" onClick={closePanel}><X aria-hidden="true" /></button></header>
      <div className="conversation-ai-body">
      {threadListOpen && <button type="button" className="conversation-thread-scrim" aria-label="关闭对话列表" tabIndex={-1} onClick={() => { setThreadListOpen(false); historyAnchor.current?.focus() }} />}
      {threadListOpen && <nav className="conversation-thread-list" aria-label="AI 对话列表">
        {threads.map(thread => <ManagedRow key={thread.id} item={thread} scope={`threads-${conversationId}`} active={thread.id === threadId}
          disabled={threadCreating} arrange={adapter?.arrangeThread && (async change => {
            await adapter.arrangeThread!(conversationId, change)
            const updated = await adapter.listThreads!(conversationId)
            if (alive.current) setThreads(updated)
          })} remove={adapter?.deleteThread && (async () => {
            await adapter.deleteThread!(conversationId, thread.id)
            if (!alive.current) return
            const remaining = threads.filter(item => item.id !== thread.id)
            setThreads(items => items.filter(item => item.id !== thread.id))
            if (activeThread.current === thread.id) activateThread(remaining[0]?.id)
            threadDrafts.current.delete(thread.id)
            threadTurns.current.delete(thread.id)
            threadScrolls.current.delete(thread.id)
            threadReferences.current.delete(thread.id)
          })} onSelect={() => {
            if (thread.id !== threadId) activateThread(thread.id)
            setThreadListOpen(false)
            historyAnchor.current?.focus()
          }}><MessageCircle aria-hidden="true" /><span>{thread.title}</span></ManagedRow>)}
        {threadListError && <p role="alert" className="conversation-error">{threadListError} <button type="button" className="conversation-text-button" onClick={() => setThreadListAttempt(value => value + 1)}>重新加载对话</button></p>}
        {!threads.length && !threadListLoading && adapter?.createThread && <button className="first-conversation" type="button" disabled={threadCreating} onClick={() => void newThread(true).catch(cause => { if (alive.current) setThreadListError(errorText(cause)) })}>
          <SquarePen aria-hidden="true" />开始新对话
        </button>}
      </nav>}
      <div className="conversation-thread-content" inert={threadListOpen}>
      {!threadListOpen && threadListError && <div className="conversation-thread-error" role="alert"><p>{threadListError}</p><button type="button" className="conversation-text-button" onClick={() => setThreadListAttempt(value => value + 1)}>重新加载对话</button></div>}
      <div ref={scroll} className="conversation-ai-timeline" role="log" aria-label="AI 对话记录" aria-live="polite" onScroll={() => {
        if (scroll.current) atEnd.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 64
      }}>
        <div ref={transcript}>
        {restoring && <p role="status" className="conversation-state-copy">正在恢复对话…</p>}
        {restoreError && <p role="alert" className="conversation-error">{restoreError}</p>}
        {!threadListOpen && !turns.length && !restoring && !threadListLoading && <div className="conversation-chat-empty">
          <MessageCircle aria-hidden="true" /><strong>你想从这段聊天里了解什么？</strong><p>直接写下问题，或从原文选择想讨论的消息。</p>
        </div>}
        {turns.map(turn => <div className="conversation-turn" key={turn.request.requestId ?? turn.id}>
          <div className="conversation-user-turn"><p>{turn.request.prompt}</p><References references={turn.request.references} savedIds={turn.referenceIds} onJump={jump} /></div>
          <div className="conversation-assistant-turn"><div className="conversation-answer-label"><MessageCircle aria-hidden="true" /><strong title={[turnModel(turn).label, turnModel(turn).model].filter(Boolean).join(' | ')}>{turnModel(turn).label}</strong></div>
            {turn.status === 'running' && !turn.text && <p className="conversation-waiting" role="status">正在回答…</p>}
            {turn.text && <AnswerContent id={turn.request.requestId ?? String(turn.id)} text={turn.text} status={turn.status} />}
            {turn.status === 'failed' && <div role="alert"><p className="conversation-error">{turn.error}</p><button type="button" className="conversation-text-button" disabled={busy} onClick={() => { void send(turn) }}>重试回答</button></div>}
            {turn.status === 'stopped' && <p className="conversation-state-copy">已停止回答。</p>}
            <div className="conversation-answer-footer"><AnswerActions text={turn.text} available={turn.status !== 'running'} />
              <Usage usage={turn.usage} model={turnModel(turn)} /></div>
          </div>
        </div>)}
        </div>
      </div>
      {panelOpen && <div className="conversation-panel-composer">{referenceControl}{editor}</div>}
      </div></div>
    </aside>
  </div>
}
