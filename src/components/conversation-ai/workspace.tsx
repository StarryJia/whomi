import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, ArrowLeft, Pause, Play, Box, Check, ChevronDown, FileText, MessageCircle, PanelLeft, Square, SquarePen, X } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import type { ReferenceRange } from './selection'
import type { ConversationAiAdapter, ConversationRequest, RestoredConversationTurn } from './types'
import type { AnalysisPreparation, AiThreadSummary } from '../../shared/ai-contract'
import './workspace.css'
import './analysis-panel.css'
import { useAnalysisTask } from './use-analysis-task'
import { ConversationPopoverOwner, ModelSelector, ThinkingSelector, type ThinkingLevel } from './model-selector'
import { usePaneDivider } from '../ui/pane-divider'
import { ManagedRow } from '../ui/managed-row'
import { MemoryArticle } from '../memory-library'
import { isMemoryReport } from '../../shared/memory'
import { CherryComposer, clearComposerDraft, clearComposerInputHistory, moveComposerInputHistory, readComposerDraft, useComposerDraft, writeComposerDraft, type CherryComposerHandle } from './cherry/composer'
import { CherryMessages, type CherryMessagesHandle, type CherryMessageTurn } from './cherry/messages'
import { forgetScrollPosition } from '../../vendor/cherry-chat/messages/list/useScrollPositionMemory'
import { ConversationAcceptancePendingError, ConversationTurnError, isConversationNotSubmitted, matchesConversationRequest } from '../../data/conversation-ai-client'
import '../../vendor/cherry-chat/shared/theme.css'

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

function References({ references, savedIds, onJump, onClear, onRemove, locked = false }: {
  references: readonly ReferenceRange[]; savedIds?: readonly string[]
  onJump: (ids: readonly string[], targetId?: string) => void; onClear?: () => void; onRemove?: (id: string) => void
  locked?: boolean
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
    {onClear && <button ref={clearButton} type="button" disabled={locked} className="conversation-icon-button" aria-label="清空全部引用" title="清空全部引用" onClick={onClear}><X aria-hidden="true" /></button>}
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
          {onRemove && <button type="button" disabled={locked} className="conversation-icon-button conversation-reference-remove" aria-label={removeLabel} title={removeLabel} onClick={() => {
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

type Turn = CherryMessageTurn & { eventSequence?: number; attempt?: number }
type Slots = { analysisControl: ReactNode; chatControl: ReactNode; composer: ReactNode; panelOpen: boolean; referencesLocked: boolean }
const draftScope = (conversationId: string, threadId?: string) => `${conversationId}:${threadId ?? 'initial'}`
type UnconfirmedSubmission = { request: ConversationRequest; draftScope: string; stopRequested: boolean; retry?: Turn; retryBaseline?: { eventSequence: number; attempt: number } }
// 页面卸载只断开观察；在确认受理前继续保留原请求编号。
const unconfirmedSubmissions = new Map<string, UnconfirmedSubmission>()
const submissionListeners = new Set<() => void>()
let submissionRevision = 0
const readSubmissionRevision = () => submissionRevision
function subscribeSubmissions(listener: () => void) {
  submissionListeners.add(listener)
  return () => { submissionListeners.delete(listener) }
}
function notifySubmissions() {
  ++submissionRevision
  for (const listener of submissionListeners) listener()
}
function writeSubmission(id: string, value?: UnconfirmedSubmission) {
  if (value) unconfirmedSubmissions.set(id, value)
  else unconfirmedSubmissions.delete(id)
  notifySubmissions()
}
function retryAdvanced(turn: RestoredConversationTurn, pending: UnconfirmedSubmission) {
  const baseline = pending.retryBaseline ?? pending.retry
  return !!baseline && (turn.eventSequence ?? -1) > (baseline.eventSequence ?? -1) &&
    (baseline.attempt === undefined || (turn.attempt ?? -1) > baseline.attempt)
}
export function ConversationWorkspace({ conversationId, initialAnalysisTaskId, openAnalysisOnEntry = false, identityRevision = 0, title, messageCount, references, onClearReferences, onRestoreReferences, onJumpReference, onEndReferenceView, onOpenAnalysisResult, onConfigureModels, adapter, children }: {
  conversationId: string; identityRevision?: number; title: string; messageCount?: number; references: readonly ReferenceRange[]
  onClearReferences: () => void; onJumpReference: (ids: readonly string[], targetId?: string, pending?: boolean) => void
  onRestoreReferences?: (references: readonly ReferenceRange[]) => void
  onEndReferenceView?: () => void
  onConfigureModels?: (onReturn: () => void) => void
  openAnalysisOnEntry?: boolean; initialAnalysisTaskId?: string
  onOpenAnalysisResult?: (taskId: string) => void
  adapter?: ConversationAiAdapter; children: (slots: Slots) => ReactNode
}) {
  useSyncExternalStore(subscribeSubmissions, readSubmissionRevision, readSubmissionRevision)
  const [panelOpen, setPanelOpen] = useState(false)
  const [composerScope, setComposerScope] = useState(() => draftScope(conversationId))
  const [draft, setDraft] = useComposerDraft(composerScope)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const scopeTransfer = useRef<{ from: string; to: string } | undefined>(undefined)
  const [sendError, setSendError] = useState('')
  const [pendingAcceptance, setPendingAcceptance] = useState<{ request: ConversationRequest; stopRequested: boolean; accept: (turn?: RestoredConversationTurn) => void; confirm?: () => Promise<void>; reject: () => void }>()
  const [confirmingAcceptance, setConfirmingAcceptance] = useState(false)
  const submissionReceiver = useRef<{ requestId?: string; accept: (turn: RestoredConversationTurn) => void } | undefined>(undefined)
  const stoppingTurns = useRef(new Map<string, Promise<void>>())
  const [threadId, setThreadId] = useState<string>()
  const heldSubmission = [...unconfirmedSubmissions.values()].find(value => value.request.conversationId === conversationId && value.request.threadId === threadId)
  const submissionLocked = submitting || !!heldSubmission
  const [threads, setThreads] = useState<AiThreadSummary[]>([])
  const [threadListOpen, setThreadListOpen] = useState(false)
  const [threadListLoading, setThreadListLoading] = useState(false)
  const [threadListError, setThreadListError] = useState('')
  const [threadCreating, setThreadCreating] = useState(false)
  const creatingThread = useRef(false)
  const [threadListAttempt, setThreadListAttempt] = useState(0)
  const activeThread = useRef<string | undefined>(undefined)
  const threadGeneration = useRef(0)
  const threadTurns = useRef(new Map<string, Turn[]>())
  const threadReferences = useRef(new Map<string, readonly ReferenceRange[]>())
  const initialModel = (feature: 'analysis' | 'conversation') => adapter?.selectedModels ? adapter.selectedModels[feature] ?? '' : adapter?.models[0]?.id ?? ''
  const [modelId, setModelId] = useState(initialModel('conversation'))
  const [analysisModelId, setAnalysisModelId] = useState(initialModel('analysis'))
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>()
  const [analysisThinkingLevel, setAnalysisThinkingLevel] = useState<ThinkingLevel>()
  const [modelErrors, setModelErrors] = useState<Partial<Record<'analysis' | 'conversation', string>>>({})
  const [modelSaving, setModelSaving] = useState<Partial<Record<'analysis' | 'conversation', boolean>>>({})
  const [skillId, setSkillId] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const latestTurns = useRef(turns)
  const latestReferences = useRef(references)
  latestTurns.current = turns
  latestReferences.current = references
  const [responding, setBusy] = useState(false)
  const busy = responding || turns.some(turn => turn.status === 'running')
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
  const composer = useRef<CherryComposerHandle>(null)
  const messages = useRef<CherryMessagesHandle>(null)
  const analysisAnchor = useRef<HTMLButtonElement>(null)
  const chatAnchor = useRef<HTMLButtonElement>(null)
  const historyAnchor = useRef<HTMLButtonElement>(null)
  const chatRun = useRef<AbortController | undefined>(undefined)
  const sequence = useRef(0)
  const alive = useRef(true)
  const selectionGeneration = useRef({ analysis: 0, conversation: 0 })
  const panelId = useId()
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
  const canSend = !!adapter && !!selectedModel && !!draft.trim() && !busy && !submissionLocked && !pendingAcceptance && !restoring && !threadCreating && !threadListLoading && !threadListError && !modelSaving.conversation

  function finishSubmitting(locked: boolean) {
    submittingRef.current = locked
    setSubmitting(locked)
    if (!locked && scopeTransfer.current) {
      const { from, to } = scopeTransfer.current
      writeComposerDraft(to, readComposerDraft(from))
      clearComposerDraft(from)
      moveComposerInputHistory(from, to)
      scopeTransfer.current = undefined
      setComposerScope(to)
    }
  }

  function activateThread(id: string | undefined, keepDraft = false, keepReferences = keepDraft) {
    ++threadGeneration.current
    setConfirmingAcceptance(false)
    onEndReferenceView?.()
    threadTurns.current.set(activeThread.current ?? 'initial', latestTurns.current)
    threadReferences.current.set(activeThread.current ?? 'initial', latestReferences.current)
    chatRun.current?.abort('detach')
    chatRun.current = undefined
    activeThread.current = id
    setThreadId(id)
    const nextScope = draftScope(conversationId, id)
    if (keepDraft && submittingRef.current) scopeTransfer.current = { from: composerScope, to: nextScope }
    else {
      if (keepDraft && nextScope !== composerScope) {
        writeComposerDraft(nextScope, readComposerDraft(composerScope))
        clearComposerDraft(composerScope)
        moveComposerInputHistory(composerScope, nextScope)
      }
      setComposerScope(nextScope)
    }
    if (!keepDraft) {
      setTurns(threadTurns.current.get(id ?? '') ?? [])
    }
    setBusy(false)
    setRestoring(false)
    setRestoreError('')
    setSendError('')
    if (!keepReferences) {
      if (onRestoreReferences) onRestoreReferences(threadReferences.current.get(id ?? '') ?? [])
      else onClearReferences()
    }
    const pending = [...unconfirmedSubmissions.values()].find(value => value.request.conversationId === conversationId && value.request.threadId === id)
    if (pending && !pending.retry) onRestoreReferences?.(pending.request.references)
  }
  function focusThreadEditor() {
    setThreadListOpen(false)
    requestAnimationFrame(() => composer.current?.focus())
  }
  async function newThread(keepDraft = false) {
    if (!adapter?.createThread || creatingThread.current || restoring || threadListLoading) return
    const origin = activeThread.current
    if (origin && latestTurns.current.length === 0 && !restoreError) {
      onEndReferenceView?.()
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
        const targetScope = draftScope(conversationId, items[0].id)
        activateThread(items[0].id, !!readComposerDraft(composerScope) && !readComposerDraft(targetScope), !!latestReferences.current.length)
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
      ++threadGeneration.current
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
    const stoppingReadbacks = new Set<string>()
    setRestoring(true)
    setRestoreError('')
    const receive: Parameters<NonNullable<ConversationAiAdapter['watchThread']>>[1] = values => {
      if (controller.signal.aborted || (threadId && activeThread.current !== threadId)) return
      setRestoring(false)
      for (const value of values) {
        const pending = unconfirmedSubmissions.get(value.requestId)
        if (!pending || !matchesConversationRequest(value, pending.request) ||
          (pending.retry && !retryAdvanced(value, pending))) continue
        if (pending.stopRequested && ['queued', 'running', 'summarizing'].includes(value.state)) {
          if (adapter.stopTurn && !stoppingReadbacks.has(value.id)) {
            stoppingReadbacks.add(value.id)
            void stopPersistedTurn(value.id).then(async () => {
              if (!controller.signal.aborted && adapter.restoreThread) receive(await adapter.restoreThread(conversationId, threadId))
            }).catch(error => {
              if (!controller.signal.aborted && unconfirmedSubmissions.get(value.requestId) === pending) setSendError(errorText(error))
            }).finally(() => stoppingReadbacks.delete(value.id))
          }
          continue
        }
        if (submissionReceiver.current?.requestId === value.requestId) submissionReceiver.current.accept(value)
        else {
          writeSubmission(value.requestId)
          if (!pending.retry) { clearComposerDraft(pending.draftScope); clearComposerDraft(draftScope(conversationId, threadId)); onClearReferences() }
          setSendError('')
        }
      }
      setTurns(previous => {
        const restored: Turn[] = values.map(value => {
          const existing = previous.find(turn => turn.request.requestId === value.requestId)
          if (existing && (existing.eventSequence ?? -1) > (value.eventSequence ?? -1)) return existing
          return { id: value.id, remote: true, eventSequence: value.eventSequence, attempt: value.attempt, request: { conversationId, threadId, turnId: value.id, referenceIds: value.referenceIds, requestId: value.requestId, prompt: value.prompt,
            modelId: value.modelId, thinkingLevel: value.thinkingLevel, skillId: value.skillId, references: existing?.request.references ?? [] },
            modelIdentity: value.modelIdentity, referenceIds: value.referenceIds, text: value.text, usage: value.usage,
            error: value.error ?? (value.state === 'interrupted' ? '回答中断，请重试。' : undefined),
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
    if (!analysisOpen || !analysisConfirming || !adapter?.prepareAnalysis || !selectedAnalysisModel) {
      setPreparing(false)
      setPreparation(undefined)
      return
    }
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
    if (panelOpen) composer.current?.focus()
  }, [panelOpen])
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
  function restoredTurn(value: RestoredConversationTurn, request: ConversationRequest): Turn {
    return { id: value.id, remote: true, eventSequence: value.eventSequence, attempt: value.attempt,
      request: { ...request, turnId: value.id, requestId: value.requestId, modelId: value.modelId,
        thinkingLevel: value.thinkingLevel, skillId: value.skillId, referenceIds: value.referenceIds },
      modelIdentity: value.modelIdentity, referenceIds: value.referenceIds, text: value.text, usage: value.usage,
      error: value.error ?? (value.state === 'interrupted' ? '回答中断，请重试。' : undefined),
      status: ['queued', 'running', 'summarizing'].includes(value.state) ? 'running' : value.state === 'completed' ? 'done' : value.state === 'stopped' ? 'stopped' : 'failed' }
  }
  function replaceTurn(next: Turn) {
    setTurns(items => {
      const index = items.findIndex(item => item.request.requestId === next.request.requestId)
      if (index < 0) return [...items, next]
      const previous = items[index]
      if ((previous.eventSequence ?? -1) > (next.eventSequence ?? -1)) return items
      return items.map((item, i) => i === index ? { ...next, modelIdentity: next.modelIdentity ?? item.modelIdentity } : item)
    })
  }
  function stopPersistedTurn(id: string) {
    const existing = stoppingTurns.current.get(id)
    if (existing) return existing
    const work = (async () => {
      if (!adapter?.stopTurn) throw new Error('请重新打开当前对话，停止回答。')
      await adapter.stopTurn(id)
    })().finally(() => stoppingTurns.current.delete(id))
    stoppingTurns.current.set(id, work)
    return work
  }
  async function stopChat() {
    const running = latestTurns.current.find(turn => turn.status === 'running')
    const pending = running?.request.requestId ? unconfirmedSubmissions.get(running.request.requestId) : undefined
    if (pending) { pending.stopRequested = true; notifySubmissions() }
    const generation = threadGeneration.current
    const controller = chatRun.current
    if (running?.remote && adapter?.stopTurn) {
      controller?.abort('detach')
      chatRun.current = undefined
      try {
        await stopPersistedTurn(String(running.id))
        if (!alive.current || generation !== threadGeneration.current) return
        setBusy(false)
        setTurns(items => items.map(turn => turn.id === running.id && turn.status === 'running' ? { ...turn, status: 'stopped' } : turn))
      } catch (error) {
        if (alive.current && generation === threadGeneration.current) setRestoreError(errorText(error))
      }
    } else {
      controller?.abort()
      chatRun.current = undefined
      setBusy(false)
      setTurns(items => items.map(turn => turn.status === 'running' ? { ...turn, status: 'stopped' } : turn))
    }
  }
  async function send(text: string, retry?: Turn, recovery?: UnconfirmedSubmission): Promise<boolean> {
    if (!adapter || chatRun.current || (!recovery && (busy || heldSubmission || pendingAcceptance || (!retry && !canSend)))) return false
    setSendError('')
    retry ??= recovery?.retry
    const request: ConversationRequest = recovery?.request ?? (retry ? { ...retry.request, turnId: String(retry.id) } : {
      requestId: crypto.randomUUID(), conversationId, threadId, prompt: text,
      references: references.map(reference => ({ ...reference, messages: [...reference.messages] })), modelId,
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      history: turns.filter(turn => turn.status === 'done').flatMap(turn => [
        { role: 'user' as const, text: turn.request.prompt, references: turn.request.references },
        { role: 'assistant' as const, text: turn.text },
      ]),
      ...(references.length && adapter.skills.some(skill => skill.id === skillId) ? { skillId } : {}),
    })
    const submission: UnconfirmedSubmission = recovery ?? { request, draftScope: composerScope, stopRequested: false, retry }
    writeSubmission(request.requestId!, submission)
    const id = retry?.id ?? ++sequence.current
    const modelIdentity = retry ? retry.modelIdentity : (selectedModel ? { id: selectedModel.id, label: selectedModel.label, model: selectedModel.model, version: selectedModel.version } : undefined)
    try {
      request.threadId ??= adapter.createThread ? await newThread(true) : undefined
      if (!alive.current || (adapter.createThread && !request.threadId)) { writeSubmission(request.requestId!); return false }
    } catch (error) {
      writeSubmission(request.requestId!)
      if (alive.current) setSendError(errorText(error))
      return false
    }
    const next: Turn = { id, request, modelIdentity, text: '', status: 'running' }
    setTurns(items => items.some(item => item.request.requestId === request.requestId)
      ? items.map(item => item.request.requestId === request.requestId ? next : item) : [...items, next])
    setBusy(true)
    const generation = threadGeneration.current
    let accepted = false
    let settledAcceptance = false
    return new Promise<boolean>(resolve => {
      const settle = (value: boolean) => {
        if (settledAcceptance) return
        settledAcceptance = true
        resolve(value)
      }
      const current = () => alive.current && generation === threadGeneration.current
      const onAccepted = (value?: RestoredConversationTurn) => {
        if (!current()) { settle(false); return }
        if (accepted) { if (value) replaceTurn(restoredTurn(value, request)); return }
        accepted = true
        messages.current?.scrollToBottom()
        writeSubmission(request.requestId!)
        submissionReceiver.current = undefined
        if (value) replaceTurn(restoredTurn(value, request))
        if (!retry) {
          if (recovery) { clearComposerDraft(recovery.draftScope); clearComposerDraft(composerScope) }
          onClearReferences()
          if (request.threadId) setThreads(items => items.map(item => item.id === request.threadId && item.title === '新对话'
            ? { ...item, title: Array.from(request.prompt.replace(/\s+/g, ' ')).slice(0, 40).join('') } : item))
        }
        setPendingAcceptance(undefined)
        setSendError('')
        settle(true)
      }
      submissionReceiver.current = { requestId: request.requestId, accept: onAccepted }
      let observationCount = 0
      const observe = async () => {
        const firstSubmission = !recovery && observationCount++ === 0
        const controller = new AbortController()
        chatRun.current = controller
        setBusy(true)
        const active = () => current() && chatRun.current === controller
        try {
          const result = await adapter.respond(request, { signal: controller.signal, onAccepted,
            onSnapshot: value => { if (active()) replaceTurn(restoredTurn(value, request)) }, onText: value => {
            if (active()) setTurns(items => items.map(item => item.request.requestId === request.requestId && item.eventSequence === undefined ? { ...item, text: value } : item))
          } })
          if (!active()) { settle(false); return }
          if (!accepted) onAccepted(result.turn)
          if (result.turn) replaceTurn(restoredTurn(result.turn, request))
          else setTurns(items => items.map(item => item.request.requestId === request.requestId
            ? { ...item, modelIdentity: result.modelIdentity ?? item.modelIdentity, text: result.text, usage: result.usage, status: 'done' } : item))
        } catch (error) {
          if (error instanceof ConversationAcceptancePendingError && !accepted && unconfirmedSubmissions.get(request.requestId!) === submission) {
            submission.stopRequested ||= error.stopRequested
            submission.retryBaseline = error.retryBaseline
            notifySubmissions()
          }
          if (!accepted && firstSubmission && isConversationNotSubmitted(error) && unconfirmedSubmissions.get(request.requestId!) === submission) {
            writeSubmission(request.requestId!)
            if (submissionReceiver.current?.requestId === request.requestId) submissionReceiver.current = undefined
            if (current()) {
              setPendingAcceptance(undefined)
              setBusy(false)
              setSendError(error instanceof DOMException && error.name === 'AbortError' ? '' : errorText(error))
              setTurns(items => retry ? items.map(item => item.request.requestId === request.requestId ? retry : item)
                : items.filter(item => item.request.requestId !== request.requestId))
            }
            settle(false)
            return
          }
          if (!active()) { settle(false); return }
          // 再次确认的前置失败不能证明此前请求尚未入库。
          if (!firstSubmission && !accepted && isConversationNotSubmitted(error)) {
            error = new ConversationAcceptancePendingError(request.requestId!, { stopRequested: submission.stopRequested, retryBaseline: submission.retryBaseline })
          }
          if (error instanceof ConversationAcceptancePendingError && !accepted) {
            setSendError(error.message)
            setPendingAcceptance({ request, stopRequested: error.stopRequested, accept: onAccepted,
              confirm: error.stopRequested || request.turnId ? undefined : observe, reject: () => {
                writeSubmission(request.requestId!)
                submissionReceiver.current = undefined
                setTurns(items => items.filter(item => item.request.requestId !== request.requestId))
                setPendingAcceptance(undefined)
                settle(false)
              } })
          } else if (accepted || error instanceof ConversationTurnError) {
            if (error instanceof ConversationTurnError) {
              if (!accepted) onAccepted(error.turn)
              replaceTurn(restoredTurn(error.turn, request))
            } else if (!(error instanceof DOMException && error.name === 'AbortError')) {
              setRestoreError(errorText(error))
            }
          } else {
            writeSubmission(request.requestId!)
            submissionReceiver.current = undefined
            setPendingAcceptance(undefined)
            setSendError(errorText(error))
            setTurns(items => retry ? items.map(item => item.request.requestId === request.requestId ? retry : item)
              : items.filter(item => item.request.requestId !== request.requestId))
            settle(false)
          }
        } finally {
          if (active()) { chatRun.current = undefined; setBusy(false) }
        }
      }
      void observe()
    })
  }
  async function confirmPendingAcceptance() {
    if ((!pendingAcceptance && !heldSubmission) || confirmingAcceptance) return
    const generation = threadGeneration.current
    const requestId = pendingAcceptance?.request.requestId ?? heldSubmission?.request.requestId
    const capturedSubmission = requestId ? unconfirmedSubmissions.get(requestId) : undefined
    const stillPending = () => alive.current && generation === threadGeneration.current &&
      !!requestId && !!capturedSubmission && unconfirmedSubmissions.get(requestId) === capturedSubmission
    setConfirmingAcceptance(true)
    try {
      if (!pendingAcceptance && heldSubmission && !heldSubmission.stopRequested && !heldSubmission.request.turnId) { await send('', undefined, heldSubmission); return }
      const pending = pendingAcceptance ?? (heldSubmission && {
        request: heldSubmission.request, confirm: undefined,
        reject: () => { writeSubmission(heldSubmission.request.requestId!); setSendError('未发送，请重新发送。') },
        accept: (value: RestoredConversationTurn) => {
          writeSubmission(heldSubmission.request.requestId!)
          if (!heldSubmission.retry) {
            clearComposerDraft(heldSubmission.draftScope)
            clearComposerDraft(composerScope)
            onClearReferences()
          }
          replaceTurn(restoredTurn(value, heldSubmission.request))
          setSendError('')
        },
      })
      if (!pending) return
      if (pending.confirm) { await pending.confirm(); return }
      const request = pending.request
      if (!adapter?.restoreThread) throw new Error('请重新打开当前对话，确认发送状态。')
      const values = await adapter.restoreThread(request.conversationId, request.threadId)
      if (!stillPending()) return
      const saved = values.find(value => value.requestId === request.requestId)
      if (!saved) { pending.reject(); setSendError('未发送，请重新发送。'); return }
      if (!matchesConversationRequest(saved, request)) throw new Error('发送状态待确认，请再次确认。')
      const submission = unconfirmedSubmissions.get(request.requestId!)
      if (request.turnId && (!submission || !retryAdvanced(saved, submission))) throw new Error('重试状态待确认，请再次确认。')
      if (submission?.stopRequested && ['queued', 'running', 'summarizing'].includes(saved.state)) {
        if (!adapter.stopTurn) throw new Error('请重新打开当前对话，停止回答。')
        await stopPersistedTurn(saved.id)
        if (!stillPending()) return
      }
      const latest = (await adapter.restoreThread(request.conversationId, request.threadId)).find(value => value.id === saved.id)
      if (!stillPending()) return
      pending.accept(latest ?? saved)
    } catch (error) { if (stillPending()) setSendError(errorText(error)) }
    finally { if (alive.current && generation === threadGeneration.current) setConfirmingAcceptance(false) }
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
      else composer.current?.focus()
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
    if (submittingRef.current || heldSubmission) return
    onClearReferences()
    composer.current?.focus()
  }
  const threadContentActive = panelOpen && !threadListOpen
  const referenceControl = references.length > 0 && <References references={references} locked={submissionLocked}
    onJump={(ids, targetId) => jump(ids, targetId, true)} onClear={clearDraftReferences}
    onRemove={onRestoreReferences && (id => {
      if (submittingRef.current || heldSubmission) return
      const remaining = references.filter(range => range.id !== id)
      if (remaining.length) onRestoreReferences(remaining)
      else clearDraftReferences()
    })} />
  const composerToolbar = <>
    {!adapter?.models.length && onConfigureModels ? <button className="cherry-model-trigger" type="button" onClick={() => configureModels(false)}><Box aria-hidden="true" />配置模型</button>
      : <ModelSelector label="对话模型" models={adapter?.models ?? []} value={selectedModel?.id ?? ''} disabled={submissionLocked || modelSaving.conversation}
        describedBy={modelErrors.conversation ? `${panelId}-conversation-model-error` : undefined} onSelect={id => { void chooseModel('conversation', id) }} />}
    {selectedModel && <ThinkingSelector levels={selectedModel.thinkingLevels} value={thinkingLevel} onSelect={setThinkingLevel} disabled={submissionLocked || modelSaving.conversation} />}
    {references.length > 0 && !!adapter?.skills.length && <Select.Root value={skillId || 'default'} onValueChange={value => setSkillId(value === 'default' ? '' : value)} disabled={submissionLocked}>
      <Select.Trigger aria-label="对话技能" className="cherry-model-trigger cherry-skill-trigger"><FileText aria-hidden="true" /><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger>
      <Select.Portal><Select.Content className="cherry-skill-menu" position="popper" side="top" sideOffset={8} onEscapeKeyDown={event => event.stopPropagation()}><Select.Viewport>
        {[{ id: 'default', label: '默认方式' }, ...adapter.skills].map(skill => <Select.Item className="cherry-skill-option" value={skill.id} key={skill.id}><Select.ItemText>{skill.label}</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>)}
      </Select.Viewport></Select.Content></Select.Portal>
    </Select.Root>}
  </>
  const editor = <CherryComposer ref={composer} scopeKey={composerScope} value={draft} onChange={setDraft}
    onSend={text => send(text)} onStop={() => { void stopChat() }} running={busy}
    sendDisabled={!canSend} disabled={restoring || threadListLoading || !!heldSubmission} onSubmittingChange={finishSubmitting}
    toolbar={composerToolbar} references={threadContentActive ? referenceControl : undefined} />
  const chatControl = <button ref={chatAnchor} type="button" className="conversation-analysis-trigger conversation-chat-trigger" aria-expanded={panelOpen} aria-controls={panelId}
    aria-label="AI 对话" title="AI 对话" onClick={() => setPanelOpen(true)}><MessageCircle aria-hidden="true" /><span>AI 对话</span></button>
  return <div style={chatPane.style} className={`conversation-workspace${chatPane.dragging ? ' pane-resizing' : ''}${panelOpen ? ' has-ai-panel' : ''}`}>
    <div ref={source} className="conversation-source" inert={panelOpen && narrow}>{children({ analysisControl, chatControl, composer: null, panelOpen, referencesLocked: submissionLocked })}</div>
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
        <h2>AI 对话</h2><button type="button" className="conversation-icon-button" aria-label="新建 AI 对话" title="新建 AI 对话" disabled={!adapter?.createThread || threadCreating || threadListLoading || restoring || submissionLocked} onClick={() => { void newThread() }}><SquarePen aria-hidden="true" /></button>
        <button type="button" className="conversation-icon-button" aria-label="关闭 AI 对话" onClick={closePanel}><X aria-hidden="true" /></button></header>
      <div className="conversation-ai-body">
      {threadListOpen && <button type="button" className="conversation-thread-scrim" aria-label="关闭对话列表" tabIndex={-1} onClick={() => { setThreadListOpen(false); historyAnchor.current?.focus() }} />}
      {threadListOpen && <nav className="conversation-thread-list" aria-label="AI 对话列表">
        {threads.map(thread => <ManagedRow key={thread.id} item={thread} scope={`threads-${conversationId}`} active={thread.id === threadId}
          disabled={threadCreating || submissionLocked} arrange={adapter?.arrangeThread && (async change => {
            await adapter.arrangeThread!(conversationId, change)
            const updated = await adapter.listThreads!(conversationId)
            if (alive.current) setThreads(updated)
          })} remove={adapter?.deleteThread && (async () => {
            await adapter.deleteThread!(conversationId, thread.id)
            if (!alive.current) return
            const remaining = threads.filter(item => item.id !== thread.id)
            setThreads(items => items.filter(item => item.id !== thread.id))
            if (activeThread.current === thread.id) activateThread(remaining[0]?.id)
            clearComposerDraft(draftScope(conversationId, thread.id))
            clearComposerInputHistory(draftScope(conversationId, thread.id))
            forgetScrollPosition(draftScope(conversationId, thread.id))
            for (const [requestId, pending] of unconfirmedSubmissions) if (pending.request.conversationId === conversationId && pending.request.threadId === thread.id) writeSubmission(requestId)
            threadTurns.current.delete(thread.id)
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
      <div className="conversation-thread-content" data-composer-stage="" inert={threadListOpen}>
      {!threadListOpen && threadListError && <div className="conversation-thread-error" role="alert"><p>{threadListError}</p><button type="button" className="conversation-text-button" onClick={() => setThreadListAttempt(value => value + 1)}>重新加载对话</button></div>}
      <CherryMessages ref={messages} turns={turns} scopeKey={draftScope(conversationId, threadId)} running={busy || submissionLocked}
        active={threadContentActive} loading={restoring || threadListLoading} error={restoreError}
        onRetry={id => {
          const turn = latestTurns.current.at(-1)
          if (turn?.id === id && ['failed', 'stopped'].includes(turn.status) && !busy && !submissionLocked) void send('', turn)
        }}
        renderReferences={turn => <References references={turn.request.references} savedIds={turn.referenceIds} onJump={jump} />} />
      <div className="conversation-panel-composer">
        {(sendError || (heldSubmission && !submitting && !chatRun.current && !restoring)) && <p role="alert" className="conversation-error">{sendError || '发送状态待确认，请再次确认。'}{(pendingAcceptance || heldSubmission) && <button type="button" className="conversation-text-button"
          disabled={confirmingAcceptance} onClick={() => { void confirmPendingAcceptance() }}>确认发送状态</button>}</p>}
        {modelErrors.conversation && <p id={`${panelId}-conversation-model-error`} role="alert" className="conversation-error">{modelErrors.conversation}</p>}
        {editor}
      </div>
      </div></div>
    </aside>
  </div>
}
