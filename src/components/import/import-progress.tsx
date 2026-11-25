import { useId, useRef, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import type { ImportCandidateResult, ImportSnapshot } from '../../shared/import-contract'
import { ReaderDialog } from '../ui/managed-row'
import { ImportStateMark } from './import-artwork'
import { importCandidateChoices, importTitle, labelDuplicateRows, type ImportRowLabel } from './import-candidates'

function displayTitle(title: string | undefined, result: ImportCandidateResult) {
  const matched = result.matchedConversationTitle
  return matched === undefined ? importTitle(title) : `发现已有会话：${importTitle(matched)}`
}

function countText(result: ImportCandidateResult, provisional = false) {
  const { inserted, duplicates } = result
  if (!inserted) return `没有新增消息，跳过 ${duplicates} 条重复消息`
  if (duplicates || result.matchedConversationTitle !== undefined) {
    return `新增 ${inserted} 条消息，跳过 ${duplicates} 条重复消息`
  }
  return provisional ? `已处理 ${inserted} 条消息` : `已保存 ${inserted} 条消息。`
}

type ProgressProps = {
  snapshot: ImportSnapshot
  onCancel: () => void
  onOpen?: (id: string) => void
  onReset: () => void
}

function SavingSummary({ snapshot }: { snapshot: ImportSnapshot }) {
  return <>
    <ImportStateMark />
    <h2 aria-live="polite">正在保存</h2>
    <progress className="import-meter" aria-label="保存进度"
      {...(snapshot.progress?.total ? { value: snapshot.progress.processed, max: snapshot.progress.total } : {})} />
    <p className="import-muted">
      {snapshot.progress ? `已处理 ${snapshot.progress.processed}${snapshot.progress.total ? ` / ${snapshot.progress.total}` : ''} 条记录`
        : `已解析 ${snapshot.counts.validRecords} 条记录`}
    </p>
  </>
}

function processingStatus(status: ImportCandidateResult['status']) {
  switch (status) {
    case 'committing': return '处理中'
    case 'processed':
    case 'saved':
    case 'duplicate': return '已处理'
    case 'blocked':
    case 'failed': return '处理失败'
    case 'cancelled': return '已取消'
    default: return '待处理'
  }
}

function batchRows(snapshot: ImportSnapshot) {
  const choices = importCandidateChoices(snapshot.candidates, snapshot.discovery?.entries)
  const candidates = new Map(choices.map(choice => [choice.id, choice]))
  const grouped = new Map<string, ImportRowLabel & { result: ImportCandidateResult }>()
  for (const result of snapshot.results) {
    // 同一会话的分段导出要等整批提交后才有可靠的目标编号。
    const key = snapshot.status === 'completed' && result.conversationId
      ? 'conversation:' + result.conversationId : 'candidate:' + result.candidateId
    const existing = grouped.get(key)
    if (existing) {
      existing.result.inserted += result.inserted
      existing.result.duplicates += result.duplicates
      // 合并多段后，第一段的来源序号不能代表整行。
      existing.detail = ''
      continue
    }
    const candidate = candidates.get(result.candidateId)
    grouped.set(key, { result: { ...result }, title: displayTitle(candidate?.title, result),
      source: candidate?.source ?? '', detail: candidate?.detail ?? '' })
  }
  const rows = [...grouped.values()]
  labelDuplicateRows(rows)
  return rows
}

function BatchProgress({ snapshot, onCancel, onOpen, onReset }: ProgressProps) {
  const [showDetails, setShowDetails] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useId()
  const completed = snapshot.status === 'completed'
  const rows = batchRows(snapshot)
  const count = completed ? `${rows.length} 个会话` : `${rows.length} 个导入项`
  return <section className="import-step import-step-centered" aria-label="导入进度与结果">
    {completed ? <>
      <ImportStateMark state="saved" />
      <h2 role="status">导入完成</h2>
      <p>{count}</p>
      <p className="import-muted">新增 {snapshot.inserted} 条 · 跳过重复 {snapshot.duplicates} 条</p>
    </> : <SavingSummary snapshot={snapshot} />}
    <div className="import-step-actions">
      <button ref={trigger} className="import-primary" type="button" aria-haspopup="dialog" onClick={() => setShowDetails(true)}>
        {completed ? '查看导入结果' : '查看导入状态'}
      </button>
      <button className="import-secondary" type="button" onClick={completed ? onReset : onCancel}>
        {completed ? '继续导入' : '取消导入'}
      </button>
    </div>
    {showDetails && <ReaderDialog busy={false} onDismiss={() => setShowDetails(false)} returnFocus={trigger} labelledBy={heading}>
      <div className="reader-modal-overlay" onClick={event => { if (event.target === event.currentTarget) setShowDetails(false) }}>
        <section className="reader-modal-card import-details">
          <header>
            <h2 id={heading}>{completed ? '导入结果' : '会话状态'}</h2>
            <span className="import-muted">{count}</span>
            <button type="button" autoFocus aria-label="关闭" onClick={() => setShowDetails(false)}><X size={19} /></button>
          </header>
          <ul className="import-detail-list" tabIndex={0} aria-label="会话明细">
            {rows.map(({ result, title, detail }) => <li key={result.candidateId}>
              <div className="import-detail-name"><h3>{title}</h3>{detail && <small className="import-muted">{detail}</small>}</div>
              {completed ? <>
                <span>新增 {result.inserted} 条 · 跳过重复 {result.duplicates} 条</span>
                {onOpen && result.conversationId && <button className="reader-modal-btn" type="button"
                  onClick={() => { setShowDetails(false); onOpen(result.conversationId!) }}>打开会话</button>}
              </> : <span className="import-detail-state" data-state={result.status}>{processingStatus(result.status)}</span>}
            </li>)}
          </ul>
        </section>
      </div>
    </ReaderDialog>}
  </section>
}

export function ImportProgress({ snapshot, onCancel, onOpen, onReset }: ProgressProps) {
  if (snapshot.results.length > 1) return <BatchProgress key={snapshot.jobId} snapshot={snapshot}
    onCancel={onCancel} onOpen={onOpen} onReset={onReset} />
  const [result] = snapshot.results
  const title = result && displayTitle(snapshot.candidates.find(candidate => candidate.candidateId === result.candidateId)?.title, result)
  if (snapshot.status !== 'completed') {
    const processed = result && ['processed', 'saved', 'duplicate'].includes(result.status)
    return <section className="import-step import-step-centered" aria-label="导入进度与结果">
      <SavingSummary snapshot={snapshot} />
      <div className="import-step-actions">
        <button className="import-secondary" type="button" onClick={onCancel}>取消导入</button>
      </div>
      {processed && <ul className="import-results import-processed" aria-label="已处理的会话">
        <li>
          <details>
            <summary><ChevronRight size={16} aria-hidden="true" />{title}</summary>
            <p className="import-muted">{countText(result, true)}</p>
          </details>
        </li>
      </ul>}
    </section>
  }

  const conversationId = result?.conversationId
  return <section className="import-step import-step-centered import-result-single" aria-label="导入进度与结果">
    <ImportStateMark state="saved" />
    <p className="import-status" role="status">导入完成</p>
    {result && <ul className="import-results">
      <li>
        <h3>{title}</h3>
        <p>{countText(result)}</p>
      </li>
    </ul>}
    <div className="import-step-actions">
      {conversationId && onOpen && <button className="import-primary" type="button"
        onClick={() => onOpen(conversationId)}>打开会话</button>}
      <button className={conversationId && onOpen ? 'import-secondary' : 'import-primary'} type="button" onClick={onReset}>
        继续导入
      </button>
    </div>
  </section>
}
