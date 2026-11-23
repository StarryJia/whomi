import type { Store } from '../db/open'
import { cleanupRegisteredStaging } from './snapshot'
import type { ImportFailurePhase, ImportJobState } from '../../../src/shared/import-contract'
import { currentImportIssue, type ImportDiagnosticReceipt, type PersistedImportFailure, type StoredImportDiagnostic } from '../../../src/shared/import-diagnostics'
import { operationRetentionMs } from '../../../src/shared/operation-diagnostics'
import { finishJob, recordImportFailure } from './state'
import { issue } from './limits'
import { rebuildSummary } from './summary'
export async function cleanupImportStaging(store: Store, jobId: string): Promise<void> {
  const db = store.writer
  const records = db.prepare('SELECT path,app_directory appDirectory,root,identity FROM import_staging_areas WHERE job_id=?').all(BigInt(jobId)) as {path:string;appDirectory:string;root:string;identity:string}[]
  for (const record of records) {
    await cleanupRegisteredStaging(record)
    db.prepare('DELETE FROM import_staging_areas WHERE path=?').run(record.path)
  }
}

type FailureRow = { id: bigint; createdAt: bigint; endedAt: bigint; phase: ImportFailurePhase; issues: string | null; counts: string | null; saved: string | null }
const importFailureQuery = `SELECT id, created_at_ms createdAt, COALESCE(completed_at_ms,created_at_ms) endedAt,
  json_extract(metadata,'$.failurePhase') phase, json_extract(metadata,'$.issues') issues,
  json_extract(metadata,'$.counts') counts, json_extract(metadata,'$.diagnosticReceipt') saved
  FROM import_jobs WHERE phase='failed' AND json_type(metadata,'$.failurePhase')='text'`

function persistedFailure(row: FailureRow): PersistedImportFailure {
  const jobId = String(row.id), jobCreatedAt = Number(row.createdAt), endedAt = Number(row.endedAt)
  const code = currentImportIssue(row.phase, JSON.parse(row.issues ?? '[]'))?.code ?? 'IMPORT_FAILED'
  const signature = JSON.stringify([endedAt, row.phase, code])
  return { diagnostic: { jobId, phase: row.phase, code }, jobCreatedAt, endedAt,
    receipt: { jobId, jobCreatedAt, signature }, reported: row.saved === signature,
    ...(row.counts && { counts: JSON.parse(row.counts) }) }
}

export function unresolvedImportDiagnostics(store: Store): StoredImportDiagnostic[] {
  const rows = store.reader.prepare(importFailureQuery + ' AND COALESCE(completed_at_ms,created_at_ms)>? ORDER BY endedAt,id')
    .all(Date.now() - operationRetentionMs) as FailureRow[]
  return rows.map(persistedFailure).filter(failure => !failure.reported).map(({ diagnostic, jobCreatedAt, counts }) => ({
    diagnostic, jobCreatedAt, ...(counts && { counts }),
  }))
}

export function getImportDiagnosticFailure(store: Store, jobId: string): PersistedImportFailure | undefined {
  const row = store.reader.prepare(importFailureQuery + ' AND id=?').get(BigInt(jobId)) as FailureRow | undefined
  return row && persistedFailure(row)
}

export function acknowledgeImportDiagnostic(store: Store, receipt: ImportDiagnosticReceipt) {
  const failure = getImportDiagnosticFailure(store, receipt.jobId)
  if (failure && !failure.reported && failure.jobCreatedAt === receipt.jobCreatedAt && failure.receipt.signature === receipt.signature) {
    store.writer.prepare("UPDATE import_jobs SET metadata=json_set(metadata,'$.diagnosticReceipt',?) WHERE id=? AND created_at_ms=?")
      .run(receipt.signature, BigInt(receipt.jobId), receipt.jobCreatedAt)
  }
}

export function getInterruptedImport(store: Store): string | null {
  const job = store.reader.prepare(`SELECT id, json_extract(metadata,'$.failurePhase') failurePhase,
    json_extract(metadata,'$.issues') issues FROM import_jobs WHERE id=(SELECT max(id) FROM import_jobs) AND phase='failed'`).get() as {
    id: bigint; failurePhase: ImportFailurePhase | null; issues: string | null
  } | undefined
  if (!job?.failurePhase) return null
  const issue = currentImportIssue(job.failurePhase, JSON.parse(job.issues ?? '[]'))
  return issue?.code === 'INTERRUPTED' ? job.id.toString() : null
}

export async function recoverImports(store: Store): Promise<void> {
  const db=store.writer
  const jobs=db.prepare("SELECT id,phase FROM import_jobs WHERE phase NOT IN ('completed','partially_completed','failed','cancelled')").all() as {id:bigint;phase:ImportJobState}[]
  db.transaction(()=> {
    for(const {id,phase} of jobs) {
      const failure = issue('INTERRUPTED')
      db.prepare("UPDATE import_results SET status='failed',phase='failed',error_code=?,error_action=?,metadata=json_set(metadata,'$.issues',json(?)) WHERE job_id=? AND status!='committed'").run(failure.code,failure.action,JSON.stringify([failure]),id)
      if (db.prepare("SELECT 1 FROM import_results WHERE job_id=? AND status='committed' LIMIT 1").get(id)) {
        finishJob(store,id.toString())
      } else {
        const interruptedPhase: ImportFailurePhase = phase === 'committing' ? 'save' : phase === 'staging' || phase === 'validating' || phase === 'awaiting_commit' ? 'parse' : 'scan'
        recordImportFailure(store,id.toString(),interruptedPhase,failure)
      }
    }
    const savedJobs=db.prepare("SELECT DISTINCT j.id FROM import_jobs j JOIN import_results r ON r.job_id=j.id WHERE r.status='committed' AND j.phase IN ('failed','cancelled','partially_completed','completed')").all() as {id:bigint}[]
    for(const {id} of savedJobs) finishJob(store,id.toString())
  }).immediate()
  const summaries=db.prepare("SELECT conversation_id FROM conversation_summaries WHERE status='pending'").all() as {conversation_id:bigint}[]
  for(const r of summaries) try {await rebuildSummary(store,r.conversation_id.toString())} catch {db.prepare("UPDATE conversation_summaries SET status='failed' WHERE conversation_id=?").run(r.conversation_id)}
  const areas=db.prepare('SELECT path,app_directory appDirectory,root,identity FROM import_staging_areas').all() as {path:string;appDirectory:string;root:string;identity:string}[]
  for(const record of areas) {
    try {await cleanupRegisteredStaging(record); db.prepare('DELETE FROM import_staging_areas WHERE path=?').run(record.path)}
    catch { /* Preserve an unverifiable directory for the user; never follow replacement junctions. */ }
  }
}
