import { isImportActive, isPersistedResult } from '../../data/use-import'
import type { ImportSnapshot } from '../../shared/import-contract'

const statusLabels = {
  preparing: '正在准备…', scanning: '正在查找文件入口…', awaiting_confirmation: '请选择要解析的入口。', staging: '正在解析…', validating: '正在校验…',
  awaiting_commit: '请确认会话后保存。', committing: '正在保存…', completed: '导入完成。', partially_completed: '部分会话未完成，请查看下方结果。', failed: '导入失败，请查看操作提示。', cancelled: '已取消导入。',
}
const resultLabels = { pending: '等待处理', blocked: '无法保存', staged: '已解析，尚未保存', committing: '正在保存…', saved: '已保存', duplicate: '重复无新增', failed: '导入失败', cancelled: '已取消' }
export function ImportProgress({ snapshot, busy, onCancel, onOpen, onRetrySummary, retriedSummaries }: {
  snapshot: ImportSnapshot; busy: boolean; onCancel: () => void; onOpen?: (id: string) => void
  onRetrySummary: (id: string) => void; retriedSummaries: ReadonlySet<string>
}) {
  return <section className="import-panel" aria-label="导入进度与结果">
    <p role="status">{statusLabels[snapshot.status]}</p>
    {['staging', 'validating', 'committing'].includes(snapshot.status) && <p className="import-muted">已检查 {snapshot.counts.seen} 条记录 · 有效 {snapshot.counts.validRecords} 条 · 异常 {snapshot.counts.invalidRecords} 条</p>}
    {isImportActive(snapshot) && <button className="import-secondary" type="button" disabled={busy} onClick={onCancel}>取消导入</button>}
    {snapshot.issues.map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
    <ul className="import-results">{snapshot.results.map(result => {
      const persisted = isPersistedResult(result)
      const title = snapshot.candidates.find(candidate => candidate.candidateId === result.candidateId)?.title || `导入项 ${result.candidateId}`
      return <li key={result.candidateId}>
        <h3>{title}</h3>
        <p>{persisted ? result.status === 'duplicate' ? `新增 0 条消息，重复 ${result.duplicates} 条。` : `已保存 ${result.inserted} 条消息。` : result.status === 'saved' || result.status === 'duplicate' ? '请重新查询保存结果。' : resultLabels[result.status]}</p>
        {persisted && result.status !== 'duplicate' && result.duplicates > 0 && <p className="import-muted">跳过重复 {result.duplicates} 条。</p>}
        {result.issues.map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
        {persisted && <button className="import-secondary" type="button" disabled={!onOpen} onClick={() => onOpen?.(result.conversationId!)}>打开会话</button>}
        {persisted && result.summaryFailed && !retriedSummaries.has(result.conversationId!) && <>
          <p className="import-muted">消息已保存，摘要待更新。</p>
          <button className="import-secondary" type="button" onClick={() => onRetrySummary(result.conversationId!)}>重试摘要</button>
        </>}
        {retriedSummaries.has(result.conversationId!) && <p role="status">摘要已更新。</p>}
      </li>
    })}</ul>
  </section>
}
