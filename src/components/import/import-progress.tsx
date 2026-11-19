import { ChevronRight } from 'lucide-react'
import type { ImportCandidateResult, ImportSnapshot } from '../../shared/import-contract'
import { ImportStateMark } from './import-artwork'

function displayTitle(snapshot: ImportSnapshot, result: ImportCandidateResult) {
  const matched = result.matchedConversationTitle
  if (matched !== undefined) return `发现已有会话：${matched.trim() || '未命名会话'}`
  return snapshot.candidates.find(candidate => candidate.candidateId === result.candidateId)?.title || '未命名会话'
}

function countText(result: ImportCandidateResult, provisional = false) {
  const { inserted, duplicates } = result
  if (!inserted) return `没有新增消息，跳过 ${duplicates} 条重复消息`
  if (duplicates || result.matchedConversationTitle !== undefined) {
    return `新增 ${inserted} 条消息，跳过 ${duplicates} 条重复消息`
  }
  return provisional ? `已处理 ${inserted} 条消息` : `已保存 ${inserted} 条消息。`
}

export function ImportProgress({ snapshot, onCancel, onOpen, onReset }: {
  snapshot: ImportSnapshot
  onCancel: () => void
  onOpen?: (id: string) => void
  onReset: () => void
}) {
  if (snapshot.status !== 'completed') {
    const processed = snapshot.results.filter(result => ['processed', 'saved', 'duplicate'].includes(result.status))
    return <section className="import-step import-step-centered" aria-label="导入进度与结果">
      <ImportStateMark />
      <h2 aria-live="polite">正在保存</h2>
      <progress className="import-meter" aria-label="保存进度"
        {...(snapshot.progress?.total ? { value: snapshot.progress.processed, max: snapshot.progress.total } : {})} />
      <p className="import-muted">
        {snapshot.progress ? `已处理 ${snapshot.progress.processed}${snapshot.progress.total ? ` / ${snapshot.progress.total}` : ''} 条记录`
          : `已解析 ${snapshot.counts.validRecords} 条记录`}
      </p>
      <div className="import-step-actions">
        <button className="import-secondary" type="button" onClick={onCancel}>取消导入</button>
      </div>
      {processed.length > 0 && <ul className="import-results import-processed" aria-label="已处理的会话">
        {processed.map(result => <li key={result.candidateId}>
          <details>
            <summary><ChevronRight size={16} aria-hidden="true" />{displayTitle(snapshot, result)}</summary>
            <p className="import-muted">{countText(result, true)}</p>
          </details>
        </li>)}
      </ul>}
    </section>
  }

  const single = snapshot.results.length === 1
  return <section className={single ? 'import-step import-step-centered import-result-single' : 'import-step'}
    aria-label="导入进度与结果">
    {single && <ImportStateMark state="saved" />}
    <p className="import-status" role="status">导入完成</p>
    <ul className="import-results">
      {snapshot.results.map(result => <li key={result.candidateId}>
        <h3>{displayTitle(snapshot, result)}</h3>
        <p>{countText(result)}</p>
        {!single && result.conversationId && onOpen && <button className="import-secondary" type="button"
          onClick={() => onOpen(result.conversationId!)}>打开会话</button>}
      </li>)}
    </ul>
    <div className="import-step-actions">
      {single && snapshot.results[0].conversationId && onOpen && <button className="import-primary" type="button"
        onClick={() => onOpen(snapshot.results[0].conversationId!)}>打开会话</button>}
      <button className={single && onOpen ? 'import-secondary' : 'import-primary'} type="button" onClick={onReset}>
        继续导入
      </button>
    </div>
  </section>
}
