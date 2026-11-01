import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, FileInput, FileText, Folder, UserRound, X } from 'lucide-react'
import type { AnalysisTask } from '../shared/ai-contract'
import type { ListArrangement } from '../shared/desktop-api'
import { isMemoryReport } from '../shared/memory'
import { MemoryArticle } from './memory-article'
import { ManagedRow } from './ui/managed-row'
import './memory-library.css'

export { MemoryArticle, predictionText } from './memory-article'
export function memoryTaskNumber(id: string) { return '#' + id.padStart(4, '0') }
const date = (value: number) => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(value)
function dateTime(value: number | null | undefined) {
  if (value == null) return '时间未记录'
  return date(value) + ' ' + new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}
function rangeText(task: AnalysisTask) {
  if (task.sourceStartTimeMs == null || task.sourceEndTimeMs == null) return '聊天时间未记录'
  return <><span>{date(task.sourceStartTimeMs)}</span><span> 至 </span><span>{date(task.sourceEndTimeMs)}</span></>
}
function modelText(task: AnalysisTask, pending: boolean) { return task.modelIdentity ? `${pending ? '模型' : '生成模型'} ${task.modelIdentity.model}` : `${pending ? '模型' : '生成模型'}未记录` }
type ConversationChoice = { id: string; title: string; messageCount: number; pinned?: boolean }

export function MemoryLibrary({ entries, unfinished, conversations, selectedId, onSelect, onStart, onImport, loading, error, retry, hasMore, loadMore, listLoading, listError, retryList, arrange, remove, arrangeConversation, removeConversation }: {
  entries: AnalysisTask[]; unfinished: AnalysisTask[]; conversations: ReadonlyArray<ConversationChoice>
  selectedId?: string; onSelect: (id?: string) => void; onStart: (conversationId: string, taskId?: string) => void; onImport: () => void
  loading: boolean; error: string; retry: () => void; hasMore: boolean; loadMore: () => void; listLoading: boolean; listError?: string; retryList: () => void
  arrange?: (change: ListArrangement) => Promise<void>; remove?: (id: string) => Promise<void>
  arrangeConversation?: (change: ListArrangement) => Promise<void>; removeConversation?: (id: string) => Promise<void>
}) {
  const [choosing, setChoosing] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [pendingCollapsed, setPendingCollapsed] = useState<Set<string>>(() => new Set())
  const chooseButton = useRef<HTMLButtonElement>(null)
  const choiceTitle = useRef<HTMLHeadingElement>(null)
  const library = useRef<HTMLElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const selected = entries.find(entry => entry.id === selectedId)
  const all = [...entries, ...unfinished.filter(item => !entries.some(entry => entry.id === item.id))]
  const groups = new Map<string, { title: string; pinned: boolean; finished: AnalysisTask[]; pending: AnalysisTask[] }>()
  for (const task of all) {
    const conversation = conversations.find(item => item.id === task.conversationId)
    const group = groups.get(task.conversationId) ?? { title: task.conversationTitle ?? conversation?.title ?? '会话 ' + task.conversationId, pinned: !!conversation?.pinned, finished: [], pending: [] }
    ;(task.state === 'completed' && task.report ? group.finished : group.pending).push(task)
    groups.set(task.conversationId, group)
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => Number(b[1].pinned) - Number(a[1].pinned))
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => { if (choosing) choiceTitle.current?.focus() }, [choosing])
  useEffect(() => {
    if (!selected) return
    setCollapsed(values => { const next = new Set(values); next.delete(selected.conversationId); return next })
    const element = dialog.current!
    if (!element.open) element.showModal()
    return () => { element.close() }
  }, [selected?.id])
  function toggle(setter: typeof setCollapsed, id: string) { setter(values => { const next = new Set(values); if (!next.delete(id)) next.add(id); return next }) }
  function cancelChoice() { setChoosing(false); requestAnimationFrame(() => chooseButton.current?.focus()) }
  function close() {
    onSelect()
    requestAnimationFrame(() => {
      const row = library.current?.querySelector<HTMLButtonElement>(`[data-memory-task="${CSS.escape(selectedId ?? '')}"] button[data-list-id]`)
      if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }) }
      else heading.current?.focus()
    })
  }
  async function removeTask(taskId: string) {
    const task = all.find(item => item.id === taskId)
    const next = all.find(item => item.id !== taskId && item.conversationId === task?.conversationId) ?? all.find(item => item.id !== taskId)
    await remove!(taskId)
    requestAnimationFrame(() => {
      const candidate = next && library.current?.querySelector<HTMLButtonElement>(`[data-memory-task="${CSS.escape(next.id)}"] button[data-list-id]`)
      const target = candidate && !candidate.closest('[hidden]') ? candidate : library.current?.querySelector<HTMLButtonElement>('.memory-group-heading')
      ;(target ?? heading.current)?.focus({ preventScroll: true })
    })
  }
  function taskRow(task: AnalysisTask, pending: boolean) {
    const title = `${task.conversationTitle ?? groups.get(task.conversationId)?.title} · ${pending ? '未完成的记忆' : isMemoryReport(task.report) ? '我们的记忆' : '分析报告'} ${memoryTaskNumber(task.id)}${pending ? ' · 继续整理' : ''}`
    return <li key={task.id} data-memory-task={task.id}>
      <ManagedRow item={{ id: task.id, title, pinned: task.pinned }} scope={`memories-${task.conversationId}`} className={`memory-task-row${pending ? ' is-pending' : ''}`}
        active={selectedId === task.id} onSelect={() => pending ? onStart(task.conversationId, task.id) : onSelect(task.id)}
        arrange={arrange} remove={remove && (() => removeTask(task.id))} memory hasPopup={pending ? undefined : 'dialog'}>
        <span className="memory-file-icon"><FileText aria-hidden="true" /></span>
        <span className="memory-task-copy">
          <span className="memory-task-title">{pending ? <span>{task.createdAtMs == null ? '创建时间未记录' : `创建于 ${dateTime(task.createdAtMs)}`}</span> : <strong>{isMemoryReport(task.report) ? '我们的记忆' : '分析报告'}</strong>}<span className="memory-task-number">{memoryTaskNumber(task.id)}</span></span>
          {!pending && <span className="memory-task-detail"><span>聊天范围</span><span className="memory-chat-range">{rangeText(task)}</span></span>}
          <span className="memory-task-meta">{pending ? <span>已整理 {task.analyzedMessages.toLocaleString('zh-CN')} / {task.totalMessages.toLocaleString('zh-CN')} 条</span> : <span>{task.completedAtMs == null ? '生成时间未记录' : `生成于 ${dateTime(task.completedAtMs)}`}</span>}<span>{modelText(task, pending)}</span></span>
          {pending && task.state === 'summarizing' && <span className="memory-task-status">正在撰写文稿</span>}
          {pending && task.error && <span className="memory-task-status">{task.error}</span>}
          {pending && !task.valid && <span className="memory-task-status">资料已变化，请重新生成记忆。</span>}
        </span>
        <span className={pending ? 'memory-resume-action' : 'memory-read-action'}>{pending ? '继续整理' : ''}<ChevronRight aria-hidden="true" /></span>
      </ManagedRow>
    </li>
  }
  return <section className="memory-library" ref={library}>
    <header><h1 ref={heading} tabIndex={-1}>记忆仓库</h1>{!choosing && !!all.length && <button ref={chooseButton} type="button" className="page-primary" onClick={() => setChoosing(true)}>生成新记忆</button>}</header>
    {error && <p role="alert">{error} <button type="button" onClick={retry}>重试</button></p>}
    {loading && !all.length && <p role="status">正在读取记忆…</p>}
    {!error && !loading && (!all.length || choosing) && <section className="memory-start" aria-label="整理记忆">
      {choosing ? <div className="memory-conversation-choices">
        <h2 tabIndex={-1} ref={choiceTitle}>选择一段会话</h2>
        {conversations.map(item => <button type="button" className="memory-choice" key={item.id} onClick={() => onStart(item.id)}><span>{item.title}<small>{item.messageCount.toLocaleString('zh-CN')} 条消息</small></span><ChevronRight aria-hidden="true" /></button>)}
        {hasMore && <button type="button" className="page-secondary" onClick={loadMore} disabled={listLoading}>加载更多会话</button>}
        {listError && <p role="alert">{listError} <button type="button" onClick={retryList}>重新读取会话</button></p>}
        {!conversations.length && !listLoading && !listError && <button type="button" className="page-primary" onClick={onImport}><FileInput aria-hidden="true" />导入聊天记录</button>}
        <button type="button" className="overview-return" onClick={cancelChoice}><ArrowLeft aria-hidden="true" />取消选择</button>
      </div> : <>
        <div className="memory-format" aria-label="文稿格式预览"><span className="memory-format-label"><BookOpen aria-hidden="true" />文稿预览</span><h2>我们的记忆</h2><ol><li>MBTI 预测</li><li>我们的记忆</li><li>我们的关系</li></ol></div>
        <div className="memory-start-copy"><h2>整理第一份记忆</h2><p>这里收藏从聊天里整理出的记忆。每份文稿都保留着你们一起经历的事。</p>
          {conversations.length ? <button ref={chooseButton} className="page-primary" type="button" onClick={() => setChoosing(true)}>生成新记忆<ArrowRight aria-hidden="true" /></button> : listError ? <button className="page-secondary" type="button" onClick={retryList}>重新读取会话</button> : !listLoading && <button className="page-primary" type="button" onClick={onImport}><FileInput aria-hidden="true" />导入聊天记录</button>}
        </div></>}
    </section>}
    {!error && !loading && selectedId && !selected && <p role="status">这份记忆已移除。</p>}
    {!choosing && <div className="memory-groups">{orderedGroups.map(([conversationId, group]) => {
      const open = !collapsed.has(conversationId), pendingOpen = !pendingCollapsed.has(conversationId)
      return <section key={conversationId} className="memory-group" aria-label={group.title}>
        <ManagedRow item={{ id: conversationId, title: group.title, pinned: group.pinned }} scope="conversations" className="memory-group-heading" active={false}
          expanded={open} controls={`memory-group-${conversationId}`} onSelect={() => toggle(setCollapsed, conversationId)} arrange={arrangeConversation} remove={removeConversation && (() => removeConversation(conversationId))}>
          <ChevronDown className={open ? '' : 'is-collapsed'} aria-hidden="true" /><span className="memory-person-icon"><UserRound aria-hidden="true" /></span><strong>{group.title}</strong><span className="memory-group-count">{group.finished.length} 份记忆{group.pending.length ? ` · ${group.pending.length} 项未完成` : ''}</span>
        </ManagedRow>
        <div id={`memory-group-${conversationId}`} hidden={!open} className="memory-group-content">
          <ul className="memory-task-list">{group.finished.map(task => taskRow(task, false))}</ul>
          {!!group.pending.length && <section className="memory-pending" aria-label={`${group.title}未完成的记忆`}>
            <button className="memory-pending-toggle" type="button" aria-expanded={pendingOpen} aria-controls={`memory-pending-${conversationId}`} onClick={() => toggle(setPendingCollapsed, conversationId)}><ChevronDown className={pendingOpen ? '' : 'is-collapsed'} aria-hidden="true" /><span className="memory-folder-icon"><Folder aria-hidden="true" /></span><strong>未完成（{group.pending.length}）</strong></button>
            <ul id={`memory-pending-${conversationId}`} hidden={!pendingOpen} className="memory-task-list memory-pending-list">{group.pending.map(task => taskRow(task, true))}</ul>
          </section>}
        </div>
      </section>
    })}</div>}
    {selected?.report && <dialog className="memory-dialog" ref={dialog} aria-labelledby="memory-title" onCancel={event => { event.preventDefault(); close() }}>
      <header><div><h2 id="memory-title">{isMemoryReport(selected.report) ? '我们的记忆' : '分析报告'}</h2><small>{selected.conversationTitle ?? '会话 ' + selected.conversationId} · <span className="memory-task-number">{memoryTaskNumber(selected.id)}</span></small></div><button type="button" aria-label="关闭记忆" onClick={close}><X aria-hidden="true" /></button></header>
      <MemoryArticle report={selected.report} />
    </dialog>}
  </section>
}
