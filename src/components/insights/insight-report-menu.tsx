import { useId, useLayoutEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import type { AnalysisTask } from '../../shared/ai-contract'
import { insightTitle } from '../../shared/conversation-insights'
import type { ListArrangement } from '../../shared/desktop-api'
import { ManagedRow } from '../ui/managed-row'
import { ExceptionNotice } from '../ui/exception-notices'
import { insightCompletedAt, insightRange, insightTaskNumber, insightTaskTitle } from './insight-task'

export type RenameReport = (taskId: string, title: string) => Promise<void>

export function InsightRenameForm({ title, onCancel, onSave, onBusy }: {
  title: string
  onCancel: () => void
  onSave: (title: string) => Promise<void>
  onBusy: (busy: boolean) => void
}) {
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ text: string; invalid?: boolean }>()
  useLayoutEffect(() => { field.current?.focus() }, [])
  async function save() {
    if (inFlight.current) return
    const name = insightTitle(draft)
    if (!name) {
      setError({ invalid: true, text: draft.trim() ? '报告名称最多 80 个字符。' : '请输入报告名称。' })
      field.current?.focus()
      return
    }
    inFlight.current = true
    setError(undefined)
    setSaving(true)
    onBusy(true)
    try {
      await onSave(name)
      onCancel()
    } catch {
      setError({ text: '保存失败，请重试。' })
    } finally {
      inFlight.current = false
      setSaving(false)
      onBusy(false)
    }
  }
  return <form className="insight-rename" aria-busy={saving}
    onSubmit={event => { event.preventDefault(); void save() }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (!inFlight.current) onCancel()
    }}>
    <label htmlFor={id}>报告名称</label>
    <div className="insight-rename-controls">
      <input ref={field} id={id} value={draft} readOnly={saving} aria-invalid={error?.invalid || undefined}
        aria-describedby={error?.invalid ? id + '-error' : undefined} onChange={event => { setDraft(event.currentTarget.value); setError(undefined) }} />
      <button type="button" className="analysis-secondary" onClick={onCancel} disabled={saving}>取消</button>
      <button type="submit" className="analysis-primary" disabled={saving}>{saving ? '正在保存…' : '保存'}</button>
    </div>
    {error?.invalid ? <p id={id + '-error'} className="insight-error" role="alert">{error.text}</p>
      : error && <ExceptionNotice title="无法保存报告名称" detail={error.text} className="insight-error" />}
  </form>
}

function ReportRowMetadata({ task }: { task: AnalysisTask }) {
  return <>
    <span className="insight-row-range"><span>对话范围 {insightRange(task)}</span><span>生成于 {insightCompletedAt(task.completedAtMs)}</span></span>
    <span className="insight-row-model"><span>模型</span><span>{task.modelIdentity?.label || task.modelId || '—'}</span></span>
    <span className="insight-row-number">{insightTaskNumber(task)}</span>
  </>
}

export function InsightReportRow({ task, conversationTitle, onOpen, onRename, onRenameBusy, arrange, remove, disabled }: {
  task: AnalysisTask
  conversationTitle: string
  onOpen: () => void
  onRename?: RenameReport
  onRenameBusy: (busy: boolean) => void
  arrange?: (change: ListArrangement) => Promise<void>
  remove?: () => Promise<void>
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const title = insightTaskTitle(task)
  const number = insightTaskNumber(task)
  const range = insightRange(task)
  function endEdit() {
    setEditing(false)
    requestAnimationFrame(() => row.current?.querySelector<HTMLButtonElement>('button[data-list-id]')?.focus({ preventScroll: true }))
  }
  return <li ref={row} data-insight-task={task.id}>
    {editing && onRename ? <div className="insight-report-row insight-report-row-editing">
      <FileText aria-hidden="true" />
      <InsightRenameForm title={title} onCancel={endEdit} onSave={value => onRename(task.id, value)} onBusy={onRenameBusy} />
      <ReportRowMetadata task={task} />
    </div> : <ManagedRow item={{ id: task.id, title: `${conversationTitle} · ${title} ${number}`, pinned: task.pinned }}
      scope={`reports-${task.conversationId}`} className="insight-report-row" active={false} disabled={disabled} onSelect={onOpen}
      arrange={arrange} rename={onRename && (() => setEditing(true))} remove={remove}
      deleteDescription={{ heading: '删除报告', content: <div className="insight-delete-details">
        <strong>{title} · {number}</strong><p><span className="insight-delete-conversation" title={conversationTitle}>会话：{conversationTitle}</span>对话范围：{range}</p>
        <p>删除后无法恢复。<br />原始聊天和其他报告会保留。</p>
      </div> }}>
      <FileText aria-hidden="true" /><strong>{title}</strong><ReportRowMetadata task={task} />
    </ManagedRow>}
  </li>
}
