import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ArrowRight, Box, Check, ChevronDown, FileText, LoaderCircle, MessageCircle, Square, X } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import type { ReferenceRange } from './selection'
import type { AnalysisProgress, AnalysisResult, ConversationAiAdapter, ConversationRequest, GenerationUsage } from './types'
import type { AnalysisPreparation } from '../../shared/ai-contract'
import './workspace.css'
import { ConversationPopoverOwner, ModelSelector, type ModelOption } from './model-selector'
import { messagePerformance } from './message-performance'

const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
function seconds(ms: number | undefined) { return valid(ms) ? `${number(ms / 1000)} 秒` : '未提供' }
function errorText(error: unknown) { return error instanceof Error ? error.message : error && typeof error === 'object' && 'action' in error && typeof error.action === 'string' ? error.action : '操作失败，请重试。' }

function Popover({ anchor, label, children, onClose, above = false, onMouseEnter, onMouseLeave, id }: {
  anchor: RefObject<HTMLElement | null>; label: string; children: ReactNode; onClose: () => void; above?: boolean
  onMouseEnter?: () => void; onMouseLeave?: () => void
  id?: string
}) {
  const body = useRef<HTMLDivElement>(null)
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
        left: Math.max(8, Math.min(target.right - rect.width, window.innerWidth - rect.width - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const resize = new ResizeObserver(place)
    if (body.current) resize.observe(body.current)
    const outside = (event: PointerEvent) => {
      if (event.composedPath().some(node => node instanceof HTMLElement && node.dataset.conversationPopoverOwner === ownerId)) return
      if (!body.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.composedPath().some(node => node instanceof HTMLElement && node.dataset.conversationPopoverOwner === ownerId)) return
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
  }, [anchor, above, ownerId])
  return createPortal(<ConversationPopoverOwner.Provider value={ownerId}><div id={id} ref={body} className="conversation-popover" role="region" aria-label={label}
    style={position} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>{children}</div></ConversationPopoverOwner.Provider>, document.body)
}

function References({ references, onJump, onClear }: {
  references: readonly ReferenceRange[]; onJump: (reference: ReferenceRange) => void; onClear?: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keep = () => { clearTimeout(timer.current); setOpen(true) }
  const leave = () => { timer.current = setTimeout(() => setOpen(false), 180) }
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!references.length) return null
  return <div className="conversation-references" onMouseEnter={keep} onMouseLeave={leave}>
    <button ref={anchor} type="button" className="conversation-reference-chip" aria-expanded={open}
      aria-label={`${references.length} 条引用`} aria-controls={open ? popoverId : undefined} onKeyDown={event => {
        if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey && open)) {
          event.preventDefault()
          setOpen(true)
          requestAnimationFrame(() => document.getElementById(popoverId)?.querySelector<HTMLButtonElement>('button')?.focus())
        }
      }} onClick={() => {
        if (references.length === 1) { setOpen(false); onJump(references[0]) }
        else setOpen(true)
      }}>
      <FileText aria-hidden="true" />{references.length} 条引用<ChevronDown aria-hidden="true" />
    </button>
    {onClear && <button type="button" className="conversation-icon-button" aria-label="清除引用" onClick={onClear}><X aria-hidden="true" /></button>}
    {open && <Popover id={popoverId} anchor={anchor} above label="引用预览" onClose={() => setOpen(false)} onMouseEnter={keep} onMouseLeave={leave}>
      <div className="conversation-reference-list">{references.map((reference, index) => {
        const first = reference.messages[0]
        return <button type="button" key={reference.id} onClick={() => { setOpen(false); onJump(reference) }}>
          <FileText aria-hidden="true" /><span><strong>引用 {index + 1} · {first?.senderName ?? '消息'}</strong>
          <span>{first?.text || '查看原文'}{reference.messages.length > 1 && ` · 共 ${reference.messages.length} 条消息`}</span></span>
        </button>
      })}</div>
    </Popover>}
  </div>
}

function Usage({ usage, model }: { usage?: GenerationUsage; model?: ModelOption }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!usage || !Object.values(usage).some(valid)) return null
  const performance = messagePerformance(usage)
  const tokens = (value?: number) => valid(value) ? `${number(value)} Tokens` : '—'
  const speed = (value?: number) => valid(value) ? `${number(value)} Token/秒` : '—'
  return <div className="conversation-usage">
    <button ref={anchor} type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {valid(usage.outputTokens) && <span>输出 {number(usage.outputTokens)} token</span>}
      {valid(usage.outputTokensPerSecond) && <span>{number(usage.outputTokensPerSecond)} token/秒</span>}
      {usage.incomplete && <span>统计不完整</span>}
      {!valid(usage.outputTokens) && !valid(usage.outputTokensPerSecond) && '生成统计'}
      <ChevronDown aria-hidden="true" />
    </button>
    {open && <Popover anchor={anchor} above label="生成统计" onClose={() => setOpen(false)}>
      <div className="cherry-usage-identity"><Box aria-hidden="true" /><div><strong>{model?.label ?? '模型'}</strong>
        {model?.providerName && <span>{model.providerName}</span>}</div>
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

type Turn = { id: number | string; request: ConversationRequest; referenceIds?: string[]; text: string; usage?: GenerationUsage; status: 'running' | 'done' | 'failed' | 'stopped'; error?: string; remote?: boolean }
type Slots = { analysisControl: ReactNode; composer: ReactNode; panelOpen: boolean }
export function ConversationWorkspace({ conversationId, messageCount, references, onClearReferences, onJumpReference, onOpenAnalysisResult, adapter, children }: {
  conversationId: string; title: string; messageCount?: number; references: readonly ReferenceRange[]
  onClearReferences: () => void; onJumpReference: (reference: ReferenceRange) => void
  onOpenAnalysisResult?: (taskId: string) => void
  adapter?: ConversationAiAdapter; children: (slots: Slots) => ReactNode
}) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const initialModel = (feature: 'analysis' | 'conversation') => adapter?.selectedModels ? adapter.selectedModels[feature] ?? '' : adapter?.models[0]?.id ?? ''
  const [modelId, setModelId] = useState(initialModel('conversation'))
  const [analysisModelId, setAnalysisModelId] = useState(initialModel('analysis'))
  const [modelErrors, setModelErrors] = useState<Partial<Record<'analysis' | 'conversation', string>>>({})
  const [modelSaving, setModelSaving] = useState<Partial<Record<'analysis' | 'conversation', boolean>>>({})
  const [skillId, setSkillId] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [analysisConfirming, setAnalysisConfirming] = useState(true)
  const [analysisState, setAnalysisState] = useState<'idle' | 'running' | 'done' | 'failed' | 'stopped'>('idle')
  const [analysisError, setAnalysisError] = useState('')
  const [progress, setProgress] = useState<AnalysisProgress>()
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult>()
  const [preparation, setPreparation] = useState<AnalysisPreparation>()
  const [preparing, setPreparing] = useState(false)
  const [prepareAttempt, setPrepareAttempt] = useState(0)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1000px)').matches)
  const source = useRef<HTMLDivElement>(null)
  const aside = useRef<HTMLElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const analysisAnchor = useRef<HTMLButtonElement>(null)
  const chatRun = useRef<AbortController | undefined>(undefined)
  const analysisRun = useRef<AbortController | undefined>(undefined)
  const sequence = useRef(0)
  const alive = useRef(true)
  const selectionGeneration = useRef({ analysis: 0, conversation: 0 })
  const panelId = useId()
  const draftId = useId()
  const scroll = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const selectedModel = adapter?.models.find(model => model.id === modelId)
  const selectedAnalysisModel = adapter?.models.find(model => model.id === analysisModelId)
  async function chooseModel(feature: 'analysis' | 'conversation', id: string) {
    const generation = ++selectionGeneration.current[feature]
    setModelErrors(current => ({ ...current, [feature]: '' }))
    setModelSaving(current => ({ ...current, [feature]: true }))
    try {
      await adapter?.selectModel?.(feature, id || null)
      if (selectionGeneration.current[feature] !== generation) return
      if (feature === 'analysis') setAnalysisModelId(id); else setModelId(id)
    } catch (error) { if (selectionGeneration.current[feature] === generation) setModelErrors(current => ({ ...current, [feature]: errorText(error) })) }
    finally { if (selectionGeneration.current[feature] === generation) setModelSaving(current => ({ ...current, [feature]: false })) }
  }
  const canSend = !!adapter && !!selectedModel && !!draft.trim() && !busy && !restoring && !modelSaving.conversation

  useEffect(() => {
    alive.current = true
    setModelId(initialModel('conversation'))
    setAnalysisModelId(initialModel('analysis'))
    setModelErrors({})
    setModelSaving({})
    setBusy(false)
    setTurns(items => items.map(turn => turn.status === 'running' ? { ...turn, status: 'stopped' } : turn))
    setAnalysisState('idle')
    setAnalysisConfirming(true)
    setAnalysisError('')
    setProgress(undefined)
    setAnalysisResult(undefined)
    return () => {
      alive.current = false
      selectionGeneration.current.analysis++
      selectionGeneration.current.conversation++
      chatRun.current?.abort('detach')
      analysisRun.current?.abort('detach')
      chatRun.current = undefined
      analysisRun.current = undefined
    }
  }, [conversationId, adapter])
  useEffect(() => {
    if (!adapter?.watchThread && !adapter?.restoreThread) return
    const controller = new AbortController()
    setRestoring(true)
    setRestoreError('')
    const receive: Parameters<NonNullable<ConversationAiAdapter['watchThread']>>[1] = values => {
      if (controller.signal.aborted) return
      setRestoring(false)
      setTurns(previous => {
        const restored: Turn[] = values.map(value => {
          const existing = previous.find(turn => turn.request.requestId === value.requestId)
          return { id: value.id, remote: true, request: { conversationId, turnId: value.id, referenceIds: value.referenceIds, requestId: value.requestId, prompt: value.prompt,
            modelId: value.modelId, skillId: value.skillId, references: existing?.request.references ?? [] },
            referenceIds: value.referenceIds, text: value.text, usage: value.usage, error: value.error,
            status: ['queued', 'running', 'summarizing'].includes(value.state) ? 'running' : value.state === 'completed' ? 'done' : value.state === 'stopped' ? 'stopped' : 'failed' }
        })
        return [...restored, ...previous.filter(turn => !turn.remote && !values.some(value => value.requestId === turn.request.requestId))]
      })
      setBusy(values.some(turn => ['queued', 'running', 'summarizing'].includes(turn.state)) || !!chatRun.current)
    }
    const work = adapter.watchThread ? adapter.watchThread(conversationId, receive, controller.signal)
      : adapter.restoreThread!(conversationId).then(receive)
    void work.catch(error => { if (!controller.signal.aborted) { setRestoring(false); setRestoreError(errorText(error)) } })
    return () => controller.abort('detach')
  }, [adapter, conversationId])
  useEffect(() => {
    if (!adapter?.watchAnalysis) return
    const controller = new AbortController()
    void adapter.watchAnalysis(conversationId, task => {
      if (controller.signal.aborted || analysisRun.current) return
      setAnalysisConfirming(false)
      setAnalysisState(!task.valid ? 'failed' : ['queued', 'running', 'summarizing'].includes(task.state) ? 'running' : task.state === 'completed' ? 'done'
        : task.state === 'stopped' ? 'stopped' : 'failed')
      setAnalysisError(!task.valid ? '本人或资料范围已变化，请重新分析。' : task.error ?? (task.state === 'interrupted' ? '分析已中断，请重新确认后继续。' : ''))
      setProgress({ analyzedMessages: task.analyzedMessages, totalMessages: task.totalMessages, usage: task.usage })
      setAnalysisResult({ taskId: task.id, usage: task.usage })
    }, controller.signal).catch(error => { if (!controller.signal.aborted) setAnalysisError(errorText(error)) })
    return () => controller.abort('detach')
  }, [adapter, conversationId])
  useEffect(() => {
    if (!analysisOpen || !analysisConfirming || !adapter?.prepareAnalysis || !selectedAnalysisModel) return
    let current = true
    setPreparing(true)
    setPreparation(undefined)
    setAnalysisError('')
    void adapter.prepareAnalysis({ conversationId, modelId: analysisModelId }).then(value => {
      if (current) setPreparation(value)
    }, error => { if (current) setAnalysisError(errorText(error)) }).finally(() => { if (current) setPreparing(false) })
    return () => { current = false }
  }, [analysisOpen, analysisConfirming, adapter, conversationId, analysisModelId, selectedAnalysisModel, prepareAttempt])
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1000px)')
    const update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    if (panelOpen) textarea.current?.focus({ preventScroll: true })
  }, [panelOpen])
  useLayoutEffect(() => {
    if (atEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [turns])
  function closePanel() {
    setPanelOpen(false)
    requestAnimationFrame(() => {
      const focusTarget = source.current?.querySelector<HTMLElement>('[data-reopen-conversation], textarea')
      focusTarget?.focus()
    })
  }
  function jump(reference: ReferenceRange) {
    if (narrow) setPanelOpen(false)
    onJumpReference(reference)
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
    const request: ConversationRequest = retry?.request ?? { requestId: crypto.randomUUID(), conversationId, prompt: draft.trim(),
      references: references.map(reference => ({ ...reference, messages: [...reference.messages] })), modelId,
      history: turns.filter(turn => turn.status === 'done').flatMap(turn => [
        { role: 'user' as const, text: turn.request.prompt, references: turn.request.references },
        { role: 'assistant' as const, text: turn.text },
      ]),
      ...(references.length && adapter.skills.some(skill => skill.id === skillId) ? { skillId } : {}) }
    const id = retry?.id ?? ++sequence.current
    const controller = new AbortController()
    chatRun.current = controller
    setPanelOpen(true)
    setBusy(true)
    atEnd.current = true
    const next: Turn = { id, request, text: '', status: 'running' }
    setTurns(items => retry ? items.map(item => item.id === id ? next : item) : [...items, next])
    if (!retry) { setDraft(''); onClearReferences() }
    const active = () => alive.current && chatRun.current === controller && !controller.signal.aborted
    try {
      const result = await adapter.respond(request, { signal: controller.signal, onText: text => {
        if (active()) setTurns(items => items.map(item => item.id === id ? { ...item, text } : item))
      } })
      if (!active()) return
      if (!result.text.trim()) throw new Error('未收到回答，请重试。')
      setTurns(items => items.map(item => item.id === id || item.request.requestId === request.requestId ? { ...item, text: result.text, usage: result.usage, status: 'done' } : item))
    } catch (error) {
      if (active()) setTurns(items => items.map(item => item.id === id ? { ...item, status: 'failed', error: errorText(error) } : item))
    } finally {
      if (active()) { chatRun.current = undefined; setBusy(false) }
    }
  }
  function stopAnalysis() {
    analysisRun.current?.abort()
    analysisRun.current = undefined
    setAnalysisState('stopped')
    if (analysisResult?.taskId) void adapter?.stopAnalysis?.(analysisResult.taskId).catch(error => setAnalysisError(errorText(error)))
  }
  async function analyze() {
    if (!adapter || !selectedAnalysisModel || modelSaving.analysis || (messageCount === 0 && !adapter.prepareAnalysis) || analysisState === 'running' || preparing || (adapter.prepareAnalysis && !preparation)) return
    const controller = new AbortController()
    analysisRun.current = controller
    setAnalysisState('running')
    setAnalysisConfirming(false)
    setAnalysisError('')
    setProgress(undefined)
    setAnalysisResult(undefined)
    const active = () => alive.current && analysisRun.current === controller && !controller.signal.aborted
    try {
      const result = await adapter.analyze({ conversationId, modelId: analysisModelId,
        ...(preparation ? { preparationToken: preparation.token, requestId: crypto.randomUUID() } : {}) }, { signal: controller.signal, onProgress: value => {
        if (!active()) return
        if (valid(value.analyzedMessages) && valid(value.totalMessages)) setProgress(value)
      } })
      if (active()) { setAnalysisResult(result || undefined); setAnalysisState('done') }
    } catch (error) {
      if (active()) { setAnalysisState('failed'); setAnalysisError(errorText(error)) }
    } finally {
      if (active()) analysisRun.current = undefined
    }
  }
  const completed = valid(progress?.analyzedMessages) ? progress.analyzedMessages : 0
  const total = valid(progress?.totalMessages) ? progress.totalMessages : messageCount
  const percentage = valid(total) && total > 0 ? Math.min(100, Math.round(completed / total * 100)) : undefined
  const analysisUsage = analysisResult?.usage ?? progress?.usage
  const analysisSpeed = analysisUsage?.outputTokensPerSecond ?? progress?.outputTokensPerSecond
  const hasAnalysisUsage = analysisUsage && Object.values(analysisUsage).some(valid)
  const confirmAnalysis = () => { setAnalysisConfirming(true); setAnalysisError(''); setPrepareAttempt(value => value + 1) }
  const analysisControl = <>
    <button ref={analysisAnchor} type="button" className="conversation-analysis-trigger" aria-expanded={analysisOpen}
      onClick={() => setAnalysisOpen(value => !value)}>
      {analysisState === 'running' ? <LoaderCircle className="conversation-working" aria-hidden="true" /> : analysisState === 'done' ? <Check aria-hidden="true" /> : <span className="conversation-ring-icon" aria-hidden="true" />}会话分析
    </button>
    {analysisOpen && <Popover anchor={analysisAnchor} label="会话分析状态" onClose={() => setAnalysisOpen(false)}>
      <h3>会话分析</h3>
      {analysisConfirming && !!adapter?.models.length && <ModelSelector label="分析模型" models={adapter.models} value={selectedAnalysisModel?.id ?? ''}
        disabled={modelSaving.analysis} describedBy={modelErrors.analysis ? `${panelId}-analysis-model-error` : undefined} onSelect={id => { void chooseModel('analysis', id) }} />}
      {analysisConfirming && modelErrors.analysis && <p id={`${panelId}-analysis-model-error`} role="alert" className="conversation-error">{modelErrors.analysis}</p>}
      {analysisConfirming && messageCount === 0 && !adapter?.prepareAnalysis ? <p className="conversation-state-copy">巧妇难为无米之炊，先导入一些聊天记录吧。</p> : analysisConfirming && (!adapter || !selectedAnalysisModel) ? <p className="conversation-state-copy">{adapter?.models.length ? '请选择分析模型。' : '请在设置中添加模型。'}</p> : analysisConfirming ? <>
        {preparing && <p role="status" className="conversation-state-copy">正在核对分析范围…</p>}
        {hasAnalysisUsage && analysisUsage.incomplete && <p className="conversation-state-copy">统计不完整</p>}
        {analysisError && <p role="alert" className="conversation-error">{analysisError}</p>}
        <p className="conversation-state-copy">根据当前会话的全部聊天内容，生成一份分析报告。</p>
        <div className="conversation-analysis-actions">
          {(!adapter?.prepareAnalysis || preparation) && <button type="button" disabled={preparing || modelSaving.analysis} className="conversation-text-button conversation-primary-button" onClick={() => { void analyze() }}>确认分析</button>}
          {adapter?.prepareAnalysis && !preparing && !preparation && <button type="button" className="conversation-text-button" onClick={confirmAnalysis}>重新核对</button>}
          <button type="button" className="conversation-text-button" onClick={() => setAnalysisOpen(false)}>取消</button>
        </div>
      </> : <>
        <div className="conversation-analysis-summary">
          <div className="conversation-progress" role="progressbar" aria-label="会话分析进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
            <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" /><circle cx="24" cy="24" r="20" strokeDasharray={`${(percentage ?? 0) * 1.257} 126`} /></svg>
            <span>{percentage === undefined ? '—' : `${percentage}%`}</span>
          </div>
          <div><p>{progress ? `已分析 ${number(completed)} / ${number(progress.totalMessages)} 条` : valid(total) ? `当前会话 ${number(total)} 条消息` : '等待消息总数'}</p>
            <p className="conversation-state-copy">{analysisState === 'running' ? '正在分析' : analysisState === 'done' ? '分析完成' : analysisState === 'stopped' ? '已停止' : analysisState === 'failed' ? '分析失败' : '生成当前会话的画像结果'}</p>
            {valid(analysisSpeed) && <p className="conversation-state-copy">生成速度 {number(analysisSpeed)} token/秒</p>}</div>
        </div>
        {hasAnalysisUsage ? <dl className="conversation-analysis-usage conversation-usage-grid" role="group" aria-label="分析用量">
          <div><dt>输入 token</dt><dd>{valid(analysisUsage.inputTokens) ? number(analysisUsage.inputTokens) : '未提供'}</dd></div>
          <div><dt>输出 token</dt><dd>{valid(analysisUsage.outputTokens) ? number(analysisUsage.outputTokens) : '未提供'}</dd></div>
          <div><dt>总耗时</dt><dd>{seconds(analysisUsage.durationMs)}</dd></div>
        </dl> : analysisState === 'done' && <p className="conversation-state-copy">未提供用量统计。</p>}
        {analysisError && <p role="alert" className="conversation-error">{analysisError}</p>}
        <div className="conversation-analysis-actions">{analysisState === 'running' ? <button type="button" className="conversation-text-button" onClick={stopAnalysis}><Square aria-hidden="true" />停止分析</button>
          : <button type="button" className="conversation-text-button" onClick={confirmAnalysis}>{analysisState === 'failed' ? '重试分析' : '重新分析'}</button>}
          {analysisState === 'done' && !!onOpenAnalysisResult && !!analysisResult?.taskId && <button type="button" className="conversation-text-button conversation-primary-button"
            onClick={() => { onOpenAnalysisResult(analysisResult.taskId!) }}>查看分析结果<ArrowRight aria-hidden="true" /></button>}
        </div>
        {analysisState === 'done' && onOpenAnalysisResult && !analysisResult?.taskId && <p className="conversation-state-copy">未提供分析报告。</p>}
      </>}
    </Popover>}
  </>
  const referenceControl = <References references={references} onJump={jump} onClear={onClearReferences} />
  const editor = <form className="conversation-composer" onSubmit={event => { event.preventDefault(); void send() }}>
    <label htmlFor={draftId} className="visually-hidden">向 AI 提问</label>
    {references.length > 0 && <div className="conversation-composer-top">{referenceControl}</div>}
    <textarea id={draftId} ref={textarea} rows={2} value={draft} placeholder="输入消息…"
      onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) void send() }
      }} />
    <div className="conversation-composer-tools">
      <ModelSelector label="对话模型" models={adapter?.models ?? []} value={selectedModel?.id ?? ''} disabled={busy || modelSaving.conversation}
        describedBy={modelErrors.conversation ? `${panelId}-conversation-model-error` : undefined} onSelect={id => { void chooseModel('conversation', id) }} />
      {references.length > 0 && !!adapter?.skills.length && <Select.Root value={skillId || 'default'} onValueChange={value => setSkillId(value === 'default' ? '' : value)} disabled={busy}>
        <Select.Trigger aria-label="对话技能" className="cherry-model-trigger cherry-skill-trigger"><FileText aria-hidden="true" /><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger>
        <Select.Portal><Select.Content className="cherry-skill-menu" position="popper" side="top" sideOffset={8} onEscapeKeyDown={event => event.stopPropagation()}><Select.Viewport>
          {[{ id: 'default', label: '默认方式' }, ...adapter.skills].map(skill => <Select.Item className="cherry-skill-option" value={skill.id} key={skill.id}><Select.ItemText>{skill.label}</Select.ItemText><Select.ItemIndicator><Check /></Select.ItemIndicator></Select.Item>)}
        </Select.Viewport></Select.Content></Select.Portal>
      </Select.Root>}
      <div className="conversation-send-tools">
        {busy ? <button type="button" className="conversation-send" aria-label="停止回答" onClick={stopChat}><Square aria-hidden="true" /></button>
          : <button type="submit" className="conversation-send" aria-label="发送给 AI" disabled={!canSend}><ArrowUp aria-hidden="true" /></button>}
      </div>
    </div>
    {modelErrors.conversation && <p id={`${panelId}-conversation-model-error`} role="alert" className="conversation-error">{modelErrors.conversation}</p>}
  </form>
  const composer = panelOpen ? null : <div className="conversation-source-composer">{turns.length > 0 && <button type="button" data-reopen-conversation className="conversation-reopen" onClick={() => setPanelOpen(true)}><MessageCircle aria-hidden="true" />继续 AI 对话</button>}{editor}</div>
  return <div className={`conversation-workspace${panelOpen ? ' has-ai-panel' : ''}`}>
    <div ref={source} className="conversation-source" inert={panelOpen && narrow}>{children({ analysisControl, composer, panelOpen })}</div>
    <aside ref={aside} id={panelId} className="conversation-ai-panel" aria-label="AI 对话" role="complementary"
      inert={!panelOpen} aria-hidden={!panelOpen} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closePanel() }
      }}>
      <header className="conversation-ai-header"><h2>AI 对话</h2><button type="button" className="conversation-icon-button" aria-label="关闭 AI 对话" onClick={closePanel}><X aria-hidden="true" /></button></header>
      <div ref={scroll} className="conversation-ai-timeline" role="log" aria-label="AI 对话记录" aria-live="polite" onScroll={() => {
        if (scroll.current) atEnd.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 64
      }}>
        {restoring && <p role="status" className="conversation-state-copy">正在恢复对话…</p>}
        {restoreError && <p role="alert" className="conversation-error">{restoreError}</p>}
        {turns.map(turn => <div className="conversation-turn" key={turn.id}>
          <div className="conversation-user-turn"><p>{turn.request.prompt}</p><References references={turn.request.references} onJump={jump} />
            {!turn.request.references.length && !!turn.referenceIds?.length && <span className="conversation-state-copy">{turn.referenceIds.length} 条参考消息</span>}</div>
          <div className="conversation-assistant-turn"><div className="conversation-answer-label"><MessageCircle aria-hidden="true" /><strong>AI</strong>{turn.status === 'running' && <span>正在回答…</span>}</div>
            {turn.text && <p className="conversation-answer-text">{turn.text}</p>}
            {turn.status === 'failed' && <div role="alert"><p className="conversation-error">{turn.error}</p><button type="button" className="conversation-text-button" disabled={busy} onClick={() => { void send(turn) }}>重试回答</button></div>}
            {turn.status === 'stopped' && <p className="conversation-state-copy">已停止回答。</p>}
            <Usage usage={turn.usage} model={adapter?.models.find(model => model.id === turn.request.modelId)} />
          </div>
        </div>)}
      </div>
      {panelOpen && <div className="conversation-panel-composer">{editor}</div>}
    </aside>
  </div>
}
