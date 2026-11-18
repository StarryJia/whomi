import { isImportActive, isPersistedResult } from '../../data/use-import'
import type { ImportSnapshot } from '../../shared/import-contract'
import type { ImportIssue } from '../../shared/conversation-model'
import { ImportStateMark } from './import-artwork'

function blockingIssues(issues: readonly ImportIssue[]) {
  const errors = issues.filter(issue => issue.severity === 'blocking')
  return errors.filter((issue, index) => !errors.some((other, otherIndex) => {
    if (other.candidateId !== issue.candidateId) return false
    return other.action === issue.action ? otherIndex < index : other.action.endsWith(issue.action)
  }))
}

const statusLabels: Record<string, string> = {
  preparing: '正在准备', scanning: '正在查找文件入口', awaiting_confirmation: '选择要解析的入口', staging: '正在解析', validating: '正在校验',
  awaiting_commit: '正在保存', committing: '正在保存', completed: '导入完成', partially_completed: '部分会话未完成', failed: '导入失败', cancelled: '已取消导入',
}
const resultLabels: Record<string, string> = { blocked: '无法保存', failed: '导入失败', cancelled: '已取消' }
export function ImportProgress({ snapshot, busy, onCancel, onOpen, onRetrySummary, retriedSummaries, retryingSummaries, onReset, onRechoose, onChooseFiles, onChooseDirectory }: {
  snapshot: ImportSnapshot; busy: boolean; onCancel: () => void; onOpen?: (id: string) => void
  onRetrySummary: (id: string) => void; retriedSummaries: ReadonlySet<string>; retryingSummaries: ReadonlySet<string>; onReset?: () => void; onRechoose?: () => void
  onChooseFiles?: () => void; onChooseDirectory?: () => void
}) {
  const active = isImportActive(snapshot)
  const results = snapshot.results.filter(result => result.status !== 'pending' && result.status !== 'staged' && result.status !== 'committing')
  const hasSaved = results.some(isPersistedResult)
  const isCancelledPartial = snapshot.status === 'cancelled' && hasSaved
  const statusMessage = isCancelledPartial ? '已取消剩余导入' : statusLabels[snapshot.status] || '处理中'
  const hasFailedOrBlocked = results.some(result => result.status === 'failed' || result.status === 'blocked')
  const singleComplete = !active && results.length === 1 && hasSaved
  const replaceSingleFile = snapshot.status === 'failed' && results.length === 1 && !hasSaved && !!onRechoose
  const unassignedIssues = snapshot.issues.filter(issue =>
    !results.some(result => result.candidateId === issue.candidateId && result.issues.some(item =>
      item.code === issue.code && item.severity === issue.severity && item.action === issue.action))
  )

  return <section className={`import-step${results.length <= 1 ? ' import-step-centered import-result-single' : ''}`} aria-label="导入进度与结果">
    {results.length <= 1 && (active ? <ImportStateMark /> :
      snapshot.status === 'completed' && hasSaved ? <ImportStateMark state="saved" /> : snapshot.status === 'failed' ? <ImportStateMark state="failed" /> : null)}
    <p className="import-status" role="status">{replaceSingleFile ? '文件导入失败' : statusMessage}</p>
    {['staging', 'validating', 'committing'].includes(snapshot.status) && <>
      <progress className="import-meter" aria-label="保存进度" {...(snapshot.progress?.total ? {value:snapshot.progress.processed,max:snapshot.progress.total}:{})} />
      <p className="import-muted">已处理 {snapshot.progress?.processed ?? snapshot.inserted + snapshot.duplicates}{snapshot.progress?.total ? ` / ${snapshot.progress.total}`:''} 条记录 · 已保存 {snapshot.inserted} 条</p>
    </>}
    {active && (
      <div className="import-step-actions">
        <button className="import-secondary" type="button" onClick={onCancel}>取消导入</button>
      </div>
    )}
    {blockingIssues(unassignedIssues).map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
    {results.length > 0 && <ul className="import-results">{results.map(result => {
      const persisted = isPersistedResult(result)
      const matchedTitle = result.matchedConversationTitle
      const title = persisted && matchedTitle !== undefined
        ? `发现已有会话：${matchedTitle.trim() ? matchedTitle : '未命名会话'} 已更新`
        : snapshot.candidates.find(candidate => candidate.candidateId === result.candidateId)?.title || `导入项 ${result.candidateId}`
      return <li key={result.candidateId}>
        <h3>{title}</h3>
        {!replaceSingleFile && <p>{persisted ? result.status === 'duplicate' ? `新增 0 条消息，重复 ${result.duplicates} 条。` : `已保存 ${result.inserted} 条消息。` : result.status === 'saved' || result.status === 'duplicate' ? '请重新查询保存结果。' : resultLabels[result.status]}</p>}
        {persisted && result.status !== 'duplicate' && result.duplicates > 0 && <p className="import-muted">跳过重复 {result.duplicates} 条。</p>}
        {blockingIssues(result.issues).map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
        {persisted && !singleComplete && <button className="import-primary" type="button" disabled={!onOpen} onClick={() => onOpen?.(result.conversationId!)}>打开会话</button>}
        {persisted && result.summaryFailed && !retriedSummaries.has(result.conversationId!) && <>
          <p className="import-muted">消息已保存，摘要待更新。</p>
          <button className="import-secondary" type="button" disabled={retryingSummaries.has(result.conversationId!)} onClick={() => onRetrySummary(result.conversationId!)}>
            {retryingSummaries.has(result.conversationId!) ? '正在更新…' : '重试摘要'}
          </button>
        </>}
        {retriedSummaries.has(result.conversationId!) && <p role="status">摘要已更新。</p>}
      </li>
    })}</ul>}
    {!active && (
      <div className="import-step-actions">
        {singleComplete && <button className="import-primary" type="button" disabled={!onOpen} onClick={() => onOpen?.(results[0].conversationId!)}>打开会话</button>}
        {replaceSingleFile && <button className="import-primary" type="button" disabled={busy} onClick={onRechoose}>重新选择文件</button>}
        {onReset && (
          <button className={hasSaved || replaceSingleFile ? 'import-secondary':'import-primary'} type="button" disabled={busy} onClick={onReset}>继续导入</button>
        )}
        {onChooseFiles && !onReset && (
          <button className="import-primary" type="button" disabled={busy} onClick={onChooseFiles}>选择文件</button>
        )}
        {onChooseDirectory && !onReset && (
          <button className="import-secondary" type="button" disabled={busy} onClick={onChooseDirectory}>选择文件夹</button>
        )}
        {hasFailedOrBlocked && onRechoose && !replaceSingleFile && (
          <button className="import-secondary" type="button" disabled={busy} onClick={onRechoose}>重新选择失败的来源</button>
        )}
      </div>
    )}
  </section>
}
