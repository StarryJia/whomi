import type { Store } from '../db/open'
import type { Candidate, ImportCandidateResult, ImportJobState, ImportSnapshot, ImportResultState } from '../../../src/shared/import-contract'
import { ImportFailure, issue } from './limits'
export const terminalStates = new Set<ImportJobState>(['completed','partially_completed','failed','cancelled'])
export function setJobState(store: Store, jobId: string, phase: ImportJobState) {
  const status = phase === 'partially_completed' ? 'completed' : terminalStates.has(phase) ? phase : phase === 'preparing' ? 'pending':'running'
  store.writer.prepare('UPDATE import_jobs SET status=?,phase=?,completed_at_ms=? WHERE id=?').run(status,phase,terminalStates.has(phase) ? Date.now():null,BigInt(jobId))
}
export function saveResult(store: Store, jobId: string, c: Candidate, phase: ImportResultState, code?: string) {
  const status=phase === 'saved' || phase === 'duplicate' ? 'committed' : phase === 'committing' ? 'running' : phase === 'failed' || phase === 'blocked' ? 'failed' : phase === 'cancelled' ? 'cancelled':'pending'
  const metadata=JSON.stringify({issues:code ? [issue(code,c.candidateId)]:c.issues})
  store.writer.prepare(`INSERT INTO import_results(job_id,candidate_id,status,phase,issue_count,error_code,error_action,metadata) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id,candidate_id) DO UPDATE SET status=excluded.status,phase=excluded.phase,issue_count=excluded.issue_count,error_code=excluded.error_code,error_action=excluded.error_action,metadata=excluded.metadata WHERE import_results.status!='committed'`).run(BigInt(jobId),c.candidateId,status,phase,code ? 1:c.issues.length,code ?? null,code ? issue(code).action:null,metadata)
}
export function getSnapshot(store: Store, jobId: string): ImportSnapshot {
  if(!/^[1-9][0-9]*$/.test(jobId) || BigInt(jobId)>9223372036854775807n) throw new ImportFailure('INVALID_JOB')
  const job=store.reader.prepare('SELECT phase,metadata FROM import_jobs WHERE id=?').get(BigInt(jobId)) as {phase:ImportJobState;metadata:string}|undefined
  if(!job) throw new ImportFailure('INVALID_JOB')
  const metadata=JSON.parse(job.metadata)
  const rows=store.reader.prepare(`SELECT r.*,s.status summary_status FROM import_results r LEFT JOIN conversation_summaries s ON s.conversation_id=r.conversation_id WHERE job_id=? ORDER BY r.id`).all(BigInt(jobId)) as {candidate_id:string;conversation_id:bigint|null;phase:ImportResultState;added_count:bigint;skipped_count:bigint;committed_at_ms:bigint|null;metadata:string;summary_status:string|null}[]
  const results: ImportCandidateResult[]=rows.map(r => ({candidateId:r.candidate_id,conversationId:r.conversation_id?.toString() ?? null,status:r.phase,inserted:Number(r.added_count),duplicates:Number(r.skipped_count),committedAt:r.committed_at_ms === null ? null:Number(r.committed_at_ms),issues:JSON.parse(r.metadata).issues ?? [],summaryFailed:r.summary_status === 'failed'}))
  return {jobId,status:job.phase,discovery:metadata.discovery ?? null,candidates:metadata.candidates ?? [],issues:metadata.issues ?? [],counts:metadata.counts ?? {seen:0,validRecords:0,invalidRecords:0},results,inserted:results.reduce((n,r)=>n+r.inserted,0),duplicates:results.reduce((n,r)=>n+r.duplicates,0)}
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
