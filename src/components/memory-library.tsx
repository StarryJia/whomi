import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, FileInput, X } from 'lucide-react'
import type { AnalysisTask } from '../shared/ai-contract'
import { dimensionKeys, isMemoryReport, type MemoryDimensions, type SavedReport } from '../shared/memory'
import './memory-library.css'

const labels = {
  E: '从互动中恢复精力', I: '从独处中恢复精力', S: '关注具体经验', N: '关注关联与可能',
  T: '侧重逻辑', F: '侧重感受', J: '偏好提前安排', P: '偏好保留弹性',
}
export function predictionText(dimensions: MemoryDimensions) {
  const known = dimensionKeys.map(key => dimensions[key]).filter(letter => letter !== null)
  if (known.length === 4) return known.join('')
  if (!known.length) return '暂难判断'
  return [...known.map(letter => letter + ' · ' + labels[letter]), '其余维度暂难判断'].join('；')
}

export function MemoryArticle({ report }: { report: SavedReport }) {
  if (!isMemoryReport(report)) return <article className="memory-prose">
    <h3>摘要</h3><p>{report.summary}</p>
    {!!report.observations.length && <section><h3>观察</h3>{report.observations.map((item, index) => <div key={index}><p>{item.text}</p>{item.limitations && <p>{item.limitations}</p>}</div>)}</section>}
    {report.limitations && <section><h3>解读范围</h3><p>{report.limitations}</p></section>}
  </article>
  return <article className="memory-prose">
    <p className="memory-scope">这是一份根据你们的聊天写成的娱乐解读。性格预测和关系印象，供你轻松回看这段经历时参考。</p>
    <section><h3><abbr title="迈尔斯–布里格斯性格类型指标">MBTI</abbr> 预测</h3><p className="memory-prediction">{predictionText(report.dimensions)}</p></section>
    <section><h3>我们的记忆</h3>{report.events.length ? report.events.map(event => <div key={event.title}><h4>{event.title}</h4><p>{event.text}</p></div>) : <p>暂未找到可整理的共同经历。</p>}</section>
    <section><h3>我们的关系</h3><p>{report.relationship}</p></section>
  </article>
}

export function MemoryLibrary({ entries, unfinished, conversations, selectedId, onSelect, onStart, onImport, loading, error, retry, hasMore, loadMore, listLoading, listError, retryList }: {
  entries: AnalysisTask[]; unfinished: AnalysisTask[]; conversations: ReadonlyArray<{ id:string; title:string; messageCount:number }>
  selectedId?: string; onSelect: (id?: string) => void; onStart:(conversationId:string, taskId?:string) => void; onImport:() => void
  loading:boolean; error:string; retry:() => void; hasMore:boolean; loadMore:() => void; listLoading:boolean; listError?:string; retryList:() => void
}) {
  const [choosing,setChoosing] = useState(false)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const choiceTitle = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (choosing) choiceTitle.current?.focus() }, [choosing])
  function cancelChoice() { setChoosing(false); requestAnimationFrame(() => chooseButton.current?.focus()) }
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const selected = entries.find(entry => entry.id === selectedId)
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    if (!selected) return
    const element = dialog.current!
    element.showModal()
    return () => { element.close() }
  }, [selected?.id])
  function close() {
    onSelect()
    requestAnimationFrame(() => {
      const row = rows.current.get(selectedId ?? '')
      if (row) {
        row.focus({ preventScroll: true })
        row.scrollIntoView({ block: 'nearest' })
      } else heading.current?.focus()
    })
  }
  const pendingList = unfinished.length ? <section className="memory-pending" aria-label="未完成的记忆"><h2>未完成的记忆</h2>
      {unfinished.map(task => <button className="memory-choice" type="button" key={task.id} onClick={() => onStart(task.conversationId, task.id)}>
        <span>{task.conversationTitle ?? '会话 ' + task.conversationId}<small>已整理 {task.analyzedMessages.toLocaleString('zh-CN')} / {task.totalMessages.toLocaleString('zh-CN')} 条 · 文稿 {task.id}</small></span>
        <span className="memory-pending-action">查看进度<ChevronRight aria-hidden="true" /></span></button>)}
    </section> : null
  return <section className="memory-library">
    <header><h1 ref={heading} tabIndex={-1}>记忆仓库</h1>{!!entries.length && <><span>{entries.length} 份记忆</span>
      {!choosing && !!conversations.length && <button ref={chooseButton} type="button" className="page-secondary" onClick={() => setChoosing(true)}>选择会话整理</button>}</>}</header>
    {error && <p role="alert">{error} <button type="button" onClick={retry}>重试</button></p>}
    {loading && !entries.length && <p role="status">正在读取记忆…</p>}
    {!error && !loading && (!entries.length || choosing) && <section className="memory-start" aria-label="整理第一份记忆">
      {choosing ? <div className="memory-conversation-choices">
        <h2 tabIndex={-1} ref={choiceTitle}>选择一段会话</h2>
        {conversations.map(item => <button type="button" className="memory-choice" key={item.id} onClick={() => onStart(item.id)}>
          <span>{item.title}<small>{item.messageCount.toLocaleString('zh-CN')} 条消息</small></span><ChevronRight aria-hidden="true" /></button>)}
        {hasMore && <button type="button" className="page-secondary" onClick={loadMore} disabled={listLoading}>加载更多会话</button>}
        {listError && <p role="alert">{listError} <button type="button" onClick={retryList}>重新读取会话</button></p>}
        <button type="button" className="overview-return" onClick={cancelChoice}><ArrowLeft aria-hidden="true" />取消选择</button>
      </div> : <>
        <div className="memory-format" aria-label="文稿格式预览"><span className="memory-format-label"><BookOpen aria-hidden="true" />文稿预览</span>
          <h2>我们的记忆</h2><ol><li>MBTI 预测</li><li>我们的记忆</li><li>我们的关系</li></ol>
        </div>
        <div className="memory-start-copy">{pendingList ?? <><h2>整理第一份记忆</h2><p>这里收藏从聊天里整理出的记忆。每份文稿都保留着你们一起经历的事。</p>
          {conversations.length ? <button ref={chooseButton} className="page-primary" type="button" onClick={() => setChoosing(true)}>选择会话整理<ArrowRight aria-hidden="true" /></button>
            : listError ? <button className="page-secondary" type="button" onClick={retryList}>重新读取会话</button>
            : !listLoading && <button className="page-primary" type="button" onClick={onImport}><FileInput aria-hidden="true" />导入聊天记录</button>}</>}
        </div></>}
    </section>}
    {!choosing && !!entries.length && pendingList}
    {!error && !loading && selectedId && !selected && <p role="status">这份记忆已移除。</p>}
    {!choosing && entries.map(entry => <button type="button" className="memory-row" aria-haspopup="dialog" key={entry.id}
      ref={el => { if (el) rows.current.set(entry.id, el); else rows.current.delete(entry.id) }} onClick={() => onSelect(entry.id)}>
      <span><strong>{entry.conversationTitle ?? '会话 ' + entry.conversationId}</strong><small>{isMemoryReport(entry.report) ? '我们的记忆' : '分析报告'} · 文稿 {entry.id}</small></span><ChevronRight aria-hidden="true" />
    </button>)}
    {selected?.report && <dialog className="memory-dialog" ref={dialog} aria-labelledby="memory-title"
      onCancel={event => { event.preventDefault(); close() }}>
      <header><div><h2 id="memory-title">{isMemoryReport(selected.report) ? '我们的记忆' : '分析报告'}</h2>
        <small>{selected.conversationTitle ?? '会话 ' + selected.conversationId} · 文稿 {selected.id}</small></div>
        <button type="button" aria-label="关闭记忆" onClick={close}><X aria-hidden="true" /></button></header>
      <MemoryArticle report={selected.report} />
    </dialog>}
  </section>
}
