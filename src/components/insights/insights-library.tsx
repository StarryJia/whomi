import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowLeft, ChevronDown, FileText, LoaderCircle, Pencil, X } from 'lucide-react'
import type { AnalysisTask } from '../../shared/ai-contract'
import { isInsightReport, type InsightReport } from '../../shared/conversation-insights'
import type { ListArrangement } from '../../shared/desktop-api'
import { MemoryArticle } from '../memory-article'
import { ReaderDialog, actionError } from '../ui/managed-row'
import { ExceptionNotice, ExceptionNoticeScope } from '../ui/exception-notices'
import { InsightArticle } from './insight-article'
import { InsightRenameForm, InsightReportRow, type RenameReport } from './insight-report-menu'
import { formatInsightNumber, insightCompletedAt, insightElapsed, insightPercentage, insightRange, insightSpeed, InsightRing, InsightStatus, insightTaskFailed, insightTaskFailureKey, insightTaskNumber, insightTaskTitle, InsightTaskDetails, InsightTaskModel } from './insight-task'
import './insights.css'

type CitationTarget = { taskId: string; citationId: string; phrase: string; conversationTitle: string; fragmentCount: number }
export type RenderInsightSource = (target: CitationTarget & { onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) => ReactNode

function ReportPage({ task, report, onBack, rename, onRenameBusy, renderSource }: {
  task: AnalysisTask; report: InsightReport; onBack: () => void; rename?: RenameReport
  onRenameBusy: (busy: boolean) => void; renderSource?: RenderInsightSource
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [citation, setCitation] = useState<CitationTarget>()
  const heading = useRef<HTMLHeadingElement>(null)
  const edit = useRef<HTMLButtonElement>(null)
  const sourceTrigger = useRef<HTMLButtonElement>(null)
  const title = insightTaskTitle(task)
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  function endEdit() {
    setEditing(false)
    requestAnimationFrame(() => edit.current?.focus({ preventScroll: true }))
  }
  return <section className="insight-reader">
    <button className="overview-return" type="button" onClick={onBack} disabled={saving}><ArrowLeft aria-hidden="true" />返回</button>
    <div className="insight-reader-content">
      <header className="insight-reader-header">
        {editing && rename ? <InsightRenameForm title={title} onCancel={endEdit} onSave={value => rename(task.id, value)}
          onBusy={value => { setSaving(value); onRenameBusy(value) }} /> :
          <div className="insight-reader-title"><h1 ref={heading} tabIndex={-1}>{title}</h1>
            {rename && <button ref={edit} className="analysis-link" type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" />重命名</button>}
          </div>}
        <dl className="insight-reader-meta">
          <div><dt>对话范围</dt><dd>{insightRange(task)}</dd></div>
          <div><dt>生成时间</dt><dd>{insightCompletedAt(task.completedAtMs)}</dd></div>
          <div><dt>模型</dt><dd>{task.modelIdentity?.label || task.modelId || '—'}</dd></div>
          <div><dt>报告编号</dt><dd>{insightTaskNumber(task)}</dd></div>
        </dl>
      </header>
      <InsightArticle report={report} onOpenCitation={renderSource && ((citationId, trigger) => {
        const reference = report.citations.find(item => item.id === citationId && item.conversationId === task.conversationId)
        if (!reference?.fragments.length) return
        sourceTrigger.current = trigger
        setCitation({ taskId: task.id, citationId, phrase: trigger.textContent ?? '', conversationTitle: task.conversationTitle ?? '会话', fragmentCount: reference.fragments.length })
      })} />
    </div>
    {citation && renderSource?.({ ...citation, onClose: () => setCitation(undefined), returnFocus: sourceTrigger })}
  </section>
}

function TaskRow({ task, onOpen, onStop, onContinue }: {
  task: AnalysisTask
  onOpen: () => void
  onStop?: (taskId: string) => Promise<void>
  onContinue?: (taskId: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<'正在暂停' | '正在继续' | '正在重试'>()
  const [error, setError] = useState<{ detail: string; attempt: number }>()
  const pending = useRef(false)
  const attempt = useRef(0)
  const status = insightTaskFailed(task) ? '生成失败'
    : task.state === 'stopped' ? '已暂停' : '生成中'
  const failed = status === '生成失败'
  const number = insightTaskNumber(task)
  const start = status === '生成中' ? onStop : task.valid ? onContinue : undefined
  async function run() {
    if (!start || pending.current) return
    pending.current = true
    setError(undefined)
    const currentAttempt = ++attempt.current
    setBusy(status === '生成中' ? '正在暂停' : failed ? '正在重试' : '正在继续')
    try { await start(task.id) }
    catch (cause) { setError({ detail: actionError(cause), attempt: currentAttempt }) }
    finally { pending.current = false; setBusy(undefined) }
  }
  return <li className="insight-task-row" data-insight-task={task.id} onClick={event => {
    const target = event.target
    if (target instanceof Element && event.currentTarget.contains(target) && !target.closest('button, a')) onOpen()
  }}>
    <div className="insight-task-row-main">
      <button className="insight-task-link" type="button" data-list-id={task.id} onClick={onOpen} aria-label={`${insightTaskTitle(task)} ${number}`}>
        <FileText aria-hidden="true" /><span><strong>{insightTaskTitle(task)}</strong><span>{number}</span></span>
      </button>
      <div className="insight-task-row-status">
        {!failed && <InsightRing percentage={insightPercentage(task.analyzedMessages, task.totalMessages)} />}
        <div><InsightStatus status={busy ?? status} />
          {!failed && <span> · {formatInsightNumber(task.analyzedMessages)} / {formatInsightNumber(task.totalMessages)} 条</span>}
          {failed && task.analyzedMessages > 0 && <span>，已保留进度</span>}
          {!failed && <small>已运行 {insightElapsed(task.elapsedMs)} · {insightSpeed(task.analyzedMessages, task.elapsedMs)}</small>}
        </div>
      </div>
      <div className="insight-task-row-actions">
        {start && <button className={status === '生成中' ? 'analysis-secondary' : 'analysis-primary'} type="button" disabled={!!busy}
          onClick={() => void run()}>{status === '生成中' ? '暂停' : failed ? '重试' : '继续洞察'}</button>}
        {failed && <button type="button" className="analysis-secondary" onClick={onOpen}>返回</button>}
      </div>
    </div>
    <div className="insight-task-row-details">
      <InsightTaskModel task={task} /><InsightTaskDetails usage={task.usage} range={insightRange(task)} />
    </div>
    {(error || (failed && task.error)) && <ExceptionNotice title={`洞察 ${insightTaskNumber(task)} ${error ? '操作失败' : '生成失败'}`}
      detail={error?.detail ?? task.error} noticeKey={error ? `insight-action:${task.id}:${error.attempt}` : insightTaskFailureKey(task)} className="insight-error" />}
  </li>
}

export function InsightsLibrary({ tasks, conversations, selectedId, onSelect, onReturn, onTask, onConversations, loading, error, retry, arrange, rename,
  remove, onStop, onContinue, onRenameBusy, renderSource }: {
  tasks: readonly AnalysisTask[]
  conversations: readonly { id: string; title: string; pinned?: boolean }[]
  selectedId?: string
  onSelect: (taskId: string) => void
  onReturn: () => void
  onTask: (conversationId: string, taskId: string) => void
  onConversations: () => void
  loading: boolean
  error: string
  retry: () => void
  arrange?: (change: ListArrangement) => Promise<void>
  rename?: RenameReport
  remove?: (id: string) => Promise<void>
  onStop?: (id: string) => Promise<void>
  onContinue?: (id: string) => Promise<void>
  onRenameBusy: (busy: boolean) => void
  renderSource?: RenderInsightSource
}) {
  const id = useId()
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const [savingTitle, setSavingTitle] = useState(false)
  const list = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const legacyReturn = useRef<HTMLButtonElement>(null)
  const previous = useRef<string | undefined>(undefined)
  const listPosition = useRef(0)
  const retryPressed = useRef(false)
  const selected = tasks.find(task => task.id === selectedId && task.state === 'completed' && task.report)
  const selectedReport = selected?.report
  const readingNew = isInsightReport(selectedReport)
  const groups = new Map<string, { title: string; pinned: boolean; tasks: AnalysisTask[] }>()
  for (const task of tasks) {
    if (task.state === 'completed' && !task.report) continue
    const conversation = conversations.find(item => item.id === task.conversationId)
    const group = groups.get(task.conversationId) ?? {
      title: conversation?.title ?? task.conversationTitle ?? `会话 ${task.conversationId}`,
      pinned: !!conversation?.pinned, tasks: [],
    }
    group.tasks.push(task)
    groups.set(task.conversationId, group)
  }
  for (const group of groups.values()) group.tasks.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
  const orderedGroups = [...groups.entries()].sort((a, b) => Number(b[1].pinned) - Number(a[1].pinned))

  function rowFor(taskId: string) {
    return list.current?.querySelector<HTMLButtonElement>(`[data-insight-task="${CSS.escape(taskId)}"] button[data-list-id]`)
  }

  useLayoutEffect(() => {
    const scroll = list.current?.closest('main')
    const oldId = previous.current
    previous.current = selected?.id
    if (selected && readingNew) {
      if (scroll) { if (!oldId) listPosition.current = scroll.scrollTop; scroll.scrollTop = 0 }
    } else if (!selected) {
      if (scroll && oldId) scroll.scrollTop = listPosition.current
      const row = oldId ? rowFor(oldId) : undefined
      if (row && !row.closest('[hidden]')) {
        row.focus({ preventScroll: true })
        row.scrollIntoView({ block: 'nearest' })
      } else heading.current?.focus({ preventScroll: true })
    }
  }, [selected?.id, readingNew])

  useEffect(() => {
    if (!retryPressed.current || loading) return
    retryPressed.current = false
    const focused = document.activeElement
    if (focused && focused !== document.body && focused !== heading.current && !focused.hasAttribute('data-insight-retry')) return
    const retryButton = list.current?.querySelector<HTMLButtonElement>('[data-insight-retry]')
    ;(retryButton ?? heading.current)?.focus({ preventScroll: true })
  }, [loading, error])

  function toggle(groupId: string) {
    if (savingTitle) return
    setCollapsed(current => {
      const next = new Set(current)
      if (!next.delete(groupId)) next.add(groupId)
      return next
    })
  }

  function locate(id: string) {
    if (savingTitle) return
    legacyReturn.current = rowFor(id) ?? null
    onSelect(id)
  }

  async function removeTask(task: AnalysisTask) {
    const before = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-insight-task] button[data-list-id]') ?? [])
      .filter(row => !row.closest('[hidden]'))
    const index = before.findIndex(row => row.dataset.listId === task.id)
    const nextId = (before[index + 1] ?? before[index - 1])?.dataset.listId
    await remove!(task.id)
    requestAnimationFrame(() => {
      const next = nextId ? rowFor(nextId) : undefined
      const group = list.current?.querySelector<HTMLButtonElement>('.insight-group-toggle')
      ;(next ?? group ?? heading.current)?.focus({ preventScroll: true })
    })
  }

  const empty = groups.size === 0
  const retryButton = <button className={empty ? 'analysis-primary' : 'analysis-secondary'} type="button" data-insight-retry
    aria-disabled={loading} onClick={() => {
      if (loading) return
      retryPressed.current = true
      retry()
    }}>重试</button>

  return <>
    <ExceptionNoticeScope active={!readingNew}><section className="insights-list" ref={list} hidden={readingNew}>
      <h1 ref={heading} tabIndex={-1}>对话洞察</h1>
      {empty && loading ? <div className="insight-list-loading" aria-busy="true">
        <p role="status"><LoaderCircle aria-hidden="true" />正在读取报告列表…</p>
        <div className="insight-skeleton" aria-hidden="true"><span /><span /></div>
        <div className="insight-skeleton" aria-hidden="true"><span /><span /></div>
      </div> : empty && error ? <div className="insight-list-empty">
        <FileText aria-hidden="true" /><ExceptionNotice title="报告列表读取失败" detail={error} noticeKey="reports-list" />{retryButton}
      </div> : empty ? <div className="insight-list-empty">
        <FileText aria-hidden="true" /><h2>暂无洞察报告</h2><p>在会话中点击会话洞察。</p>
        <button type="button" className="analysis-primary" onClick={onConversations}>前往会话</button>
      </div> : <>
        {error && <p className="insight-list-error"><ExceptionNotice title="报告列表读取失败" detail={error} noticeKey="reports-list" /> {retryButton}</p>}
        {orderedGroups.map(([groupId, group]) => {
          const open = !collapsed.has(groupId)
          const listId = id + '-' + groupId
          return <section key={groupId} className="insight-group">
            <h2><button type="button" className="insight-group-toggle" aria-expanded={open} aria-controls={listId} onClick={() => toggle(groupId)}>
              <ChevronDown aria-hidden="true" /><span title={group.title}>{group.title}（{formatInsightNumber(group.tasks.length)}）</span>
            </button></h2>
            <ExceptionNoticeScope active={open}><ul id={listId} hidden={!open}>{group.tasks.map(task => task.state === 'completed' && task.report
              ? <InsightReportRow key={task.id} task={task} conversationTitle={group.title} onOpen={() => locate(task.id)}
                onRename={rename} onRenameBusy={busy => { setSavingTitle(busy); onRenameBusy(busy) }}
                disabled={savingTitle} arrange={arrange} remove={remove && (() => removeTask(task))} />
              : <TaskRow key={task.id} task={task} onOpen={() => { if (!savingTitle) onTask(task.conversationId, task.id) }} onContinue={onContinue} onStop={onStop} />)}</ul></ExceptionNoticeScope>
          </section>
        })}
      </>}
    </section></ExceptionNoticeScope>
    {selected && selectedReport && (isInsightReport(selectedReport)
      ? <ReportPage key={selected.id} task={selected} report={selectedReport} onBack={onReturn} rename={rename}
        onRenameBusy={onRenameBusy} renderSource={renderSource} />
      : <ReaderDialog busy={false} labelledBy={id + '-legacy-title'} onDismiss={onReturn} returnFocus={legacyReturn}>
        <div className="reader-modal-overlay" onClick={event => { if (event.target === event.currentTarget) onReturn() }}>
          <section className="reader-modal-card insight-history-card">
            <header><div><h2 id={id + '-legacy-title'}>{insightTaskTitle(selected)}</h2>
              <small><span className="history-conversation-name" title={selected.conversationTitle}>{selected.conversationTitle}</span> · {insightTaskNumber(selected)}</small></div>
              <button type="button" className="insight-close" aria-label="关闭记忆" onClick={onReturn}><X aria-hidden="true" /></button>
            </header>
            <div className="insight-history-body" role="region" aria-label="报告正文" tabIndex={0}>
              <MemoryArticle report={selectedReport} />
            </div>
          </section>
        </div>
      </ReaderDialog>)}
  </>
}
