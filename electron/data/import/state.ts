import type { Store } from '../db/open'
import type { Candidate, ImportCandidateResult, ImportFailurePhase, ImportJobState, ImportSnapshot, ImportResultState } from '../../../src/shared/import-contract'
import { terminalImportStates } from '../../../src/shared/import-contract'
import type { ImportIssue } from '../../../src/shared/conversation-model'
import { ImportFailure, issue } from './limits'
import { isOperationId } from '../../../src/shared/operation-diagnostics'
export function setJobState(store: Store, jobId: string, phase: ImportJobState) {
  const status = phase === 'partially_completed' ? 'completed' : terminalImportStates.has(phase) ? phase : phase === 'preparing' ? 'pending':'running'
  store.writer.prepare('UPDATE import_jobs SET status=?,phase=?,completed_at_ms=? WHERE id=?').run(status,phase,terminalImportStates.has(phase) ? Date.now():null,BigInt(jobId))
}
export function saveResult(store: Store, jobId: string, c: Candidate, phase: ImportResultState, code?: string) {
  const status=phase === 'saved' || phase === 'duplicate' ? 'committed' : phase === 'committing' ? 'running' : phase === 'failed' || phase === 'blocked' ? 'failed' : phase === 'cancelled' ? 'cancelled':'pending'
  const metadata=JSON.stringify({issues:code ? [issue(code,c.candidateId)]:c.issues})
  store.writer.prepare(`INSERT INTO import_results(job_id,candidate_id,status,phase,issue_count,error_code,error_action,metadata) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id,candidate_id) DO UPDATE SET status=excluded.status,phase=excluded.phase,issue_count=excluded.issue_count,error_code=excluded.error_code,error_action=excluded.error_action,metadata=excluded.metadata WHERE import_results.status!='committed'`).run(BigInt(jobId),c.candidateId,status,phase,code ? 1:c.issues.length,code ?? null,code ? issue(code).action:null,metadata)
}
export function recordImportFailure(store: Store, jobId: string, phase: ImportFailurePhase, ...issues: ImportIssue[]) {
  store.writer.transaction(() => {
    store.writer.prepare("UPDATE import_jobs SET metadata=json_set(metadata, '$.failurePhase', ?, '$.issues', json(?)) WHERE id=?")
      .run(phase, JSON.stringify(issues), BigInt(jobId))
    setJobState(store, jobId, 'failed')
  })()
}
export function getSnapshot(store: Store, jobId: string, provisional?: ReadonlySet<string>): ImportSnapshot {
  if(!/^[1-9][0-9]*$/.test(jobId) || BigInt(jobId)>9223372036854775807n) throw new ImportFailure('INVALID_JOB')
  const db = provisional ? store.writer : store.reader
  const job=db.prepare('SELECT phase,metadata,created_at_ms FROM import_jobs WHERE id=?').get(BigInt(jobId)) as {phase:ImportJobState;metadata:string;created_at_ms:bigint}|undefined
  if(!job) throw new ImportFailure('INVALID_JOB')
  const metadata=JSON.parse(job.metadata)
  const operation = { ...(isOperationId(metadata.operationId) && { operationId: metadata.operationId }), ...(metadata.rolledBack === true && { rolledBack: true }) }
  const jobCreatedAt = Number(job.created_at_ms)
  const rows=db.prepare(`SELECT r.*,s.status summary_status FROM import_results r LEFT JOIN conversation_summaries s ON s.conversation_id=r.conversation_id WHERE job_id=? ORDER BY r.id`).all(BigInt(jobId)) as {candidate_id:string;conversation_id:bigint|null;phase:ImportResultState;added_count:bigint;skipped_count:bigint;committed_at_ms:bigint|null;metadata:string;summary_status:string|null}[]
  const counts = metadata.counts ?? {seen:0,validRecords:0,invalidRecords:0}
  if (!rows.length && (job.phase === 'completed' || job.phase === 'partially_completed')) {
    return {jobId, jobCreatedAt, ...operation, status:'removed', discovery:null, candidates:[], issues:[], counts, results:[], inserted:0, duplicates:0}
  }
  const results: ImportCandidateResult[] = rows.map(r => {
    const { issues, matchedConversationTitle } = JSON.parse(r.metadata)
    const awaitingCommit = provisional && (r.phase === 'saved' || r.phase === 'duplicate')
    const processed = awaitingCommit && provisional.has(r.candidate_id)
    const cancelled = job.phase === 'cancelled'
    return {
      candidateId: r.candidate_id,
      conversationId: provisional || cancelled ? null : r.conversation_id?.toString() ?? null,
      status: cancelled ? 'cancelled' : awaitingCommit ? processed ? 'processed' : 'committing' : r.phase,
      inserted: cancelled || (awaitingCommit && !processed) ? 0 : Number(r.added_count),
      duplicates: cancelled || (awaitingCommit && !processed) ? 0 : Number(r.skipped_count),
      committedAt: provisional || cancelled || r.committed_at_ms === null ? null : Number(r.committed_at_ms),
      issues: issues ?? [],
      // 会话后来出现的统计错误不改变已提交的导入结果。
      summaryFailed: !provisional && job.phase !== 'completed' && r.summary_status === 'failed',
      ...(typeof matchedConversationTitle === 'string' ? { matchedConversationTitle } : {}),
    }
  })
  return {jobId,jobCreatedAt,...operation,status:job.phase,discovery:metadata.discovery ?? null,candidates:metadata.candidates ?? [],issues:metadata.issues ?? [],counts,results,inserted:provisional ? 0 : results.reduce((n,r)=>n+r.inserted,0),duplicates:provisional ? 0 : results.reduce((n,r)=>n+r.duplicates,0),...(metadata.failurePhase ? {failurePhase:metadata.failurePhase}:{}),...(metadata.progress ? {progress:metadata.progress}:{})}
}
export function finishJob(store: Store, jobId: string, cancelled=false, fatal=false) {
  const rows=store.writer.prepare('SELECT status FROM import_results WHERE job_id=?').all(BigInt(jobId)) as {status:string}[]
  const saved=rows.filter(r=>r.status === 'committed').length, failed=rows.some(r=>r.status!=='committed')
  setJobState(store,jobId,saved && (failed || cancelled || fatal) ? 'partially_completed' : cancelled ? 'cancelled' : fatal || failed || !rows.length ? 'failed':'completed')
}
export function storageFailure(error: unknown): boolean {
  const code=error instanceof ImportFailure ? error.code : (error as NodeJS.ErrnoException)?.code ?? ''
  return ['DISK_SPACE','ENOSPC','EACCES','EPERM'].includes(code) || /^SQLITE_(FULL|IOERR|READONLY|CANTOPEN|CORRUPT|NOTADB|BUSY|LOCKED)/.test(code)
}
