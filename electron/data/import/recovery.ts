import type { Store } from '../db/open'
import { cleanupRegisteredStaging } from './snapshot'
import type { ImportFailurePhase, ImportJobState } from '../../../src/shared/import-contract'
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
