import { stat, statfs } from 'node:fs/promises'
import type { Store } from '../db/open'
import type { Candidate, ImportFailurePhase, ImportPlan } from '../../../src/shared/import-contract'
import { resolveTarget, type ResolvedTarget } from './identity'
import { commitConversation, createCommitter, reliableTargetKey, type CommitResult } from './merge'
import { prepareFallbackLedger } from './message-deduplicator'
import type { StagedImport } from './staging'
import { checkSignal, ImportFailure, importLimits, issue } from './limits'
import { recordImportFailure, setJobState, storageFailure } from './state'
import { rebuildSummary } from './summary'
import { resolveAutoTarget } from './auto-target'

export type WriterQueue = <T>(operation: () => Promise<T> | T) => Promise<T>
export type RunnerDependencies = {
  write: WriterQueue
  commit?: typeof commitConversation
  summary?: typeof rebuildSummary
  freeBytes?: (path: string) => Promise<bigint>
  changed?: (finishedCandidates?: readonly string[]) => void
  progress?: (processed: number, total: number | null) => void
}

function verifyReceipt(store: Store, jobId: string, candidates: Candidate[], result: CommitResult) {
  const timestamp = result.committedAt
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !/^[1-9][0-9]{0,18}$/.test(result.conversationId) ||
    BigInt(result.conversationId) > 9223372036854775807n || !Array.isArray(result.candidates) || result.candidates.length !== candidates.length) {
    throw new ImportFailure('SAVE_CONFIRMATION_MISSING')
  }
  const reports = new Map(result.candidates.map(row => [row.candidateId, row]))
  const read = store.writer.prepare(`SELECT conversation_id, status, phase, added_count, skipped_count, committed_at_ms
    FROM import_results WHERE job_id=? AND candidate_id=?`)
  let inserted = 0, duplicates = 0
  for (const candidate of candidates) {
    const row = read.get(BigInt(jobId), candidate.candidateId) as {
      conversation_id: bigint | null; status: string; phase: string; added_count: bigint; skipped_count: bigint; committed_at_ms: bigint | null
    } | undefined
    const report = reports.get(candidate.candidateId)
    if (!row || !report || row.status !== 'committed' || String(row.conversation_id) !== result.conversationId ||
      row.committed_at_ms !== BigInt(timestamp) || Number(row.added_count) !== report.inserted || Number(row.skipped_count) !== report.duplicates ||
      row.phase !== (report.inserted ? 'saved' : 'duplicate') || report.inserted + report.duplicates !== candidate.counts.validRecords) {
      throw new ImportFailure('SAVE_CONFIRMATION_MISSING')
    }
    inserted += report.inserted; duplicates += report.duplicates
  }
  if (inserted !== result.inserted || duplicates !== result.duplicates) throw new ImportFailure('SAVE_CONFIRMATION_MISSING')
}

export async function runImport(store: Store, staged: StagedImport, plan: ImportPlan, signal: AbortSignal, dependencies: RunnerDependencies): Promise<void> {
  const db = store.writer, id = plan.jobId
  await dependencies.write(async () => {
    const decisions = new Map(plan.decisions.map(decision => [decision.candidateId, decision]))
    const selected = new Set(plan.candidateIds ?? staged.candidates.map(candidate => candidate.candidateId))
    const candidates = staged.candidates.filter(candidate => selected.has(candidate.candidateId))
    const groups = new Map<string, { candidates: Candidate[]; target: ResolvedTarget }>()
    let phase: ImportFailurePhase = 'save'
    let candidateId = ''
    try {
      checkSignal(signal)
      if (id !== staged.jobId || !selected.size || candidates.length !== selected.size ||
        (plan.candidateIds && plan.candidateIds.length !== selected.size) ||
        decisions.size !== plan.decisions.length || [...decisions.keys()].some(key => !selected.has(key))) {
        throw new ImportFailure('INVALID_PLAN')
      }
      const parseIssue = staged.issues.find(value => value.severity === 'blocking')
      if (parseIssue) {
        phase = 'parse'; candidateId = parseIssue.candidateId
        throw new ImportFailure(parseIssue.code)
      }
      const freeBytes = dependencies.freeBytes ?? (async path => {
        const info = await statfs(path, { bigint: true })
        return info.bavail * info.bsize
      })
      if (await freeBytes(staged.path) < 3n * (await stat(staged.path, { bigint: true })).size + BigInt(importLimits.diskReserveBytes)) {
        throw new ImportFailure('DISK_SPACE')
      }
      checkSignal(signal)
      prepareFallbackLedger(store)
      db.exec('BEGIN IMMEDIATE')

      for (const candidate of staged.candidates) {
        checkSignal(signal)
        candidateId = candidate.candidateId
        if (!selected.has(candidateId)) {
          db.prepare('DELETE FROM import_results WHERE job_id=? AND candidate_id=?').run(BigInt(id), candidateId)
          continue
        }
        const resolved = decisions.has(candidateId) ? resolveTarget(store, candidate, decisions.get(candidateId))
          : await resolveAutoTarget(store, candidate, () => staged.conversation([candidateId]).messages(), signal)
        if (resolved.status !== 'matched') throw new ImportFailure(resolved.status === 'blocked' ? resolved.code : 'TARGET_REQUIRED')
        const target = resolved.target
        const key = target.conversationId ? `existing:${target.conversationId}` : `new:${reliableTargetKey(target) ?? candidateId}`
        const group = groups.get(key) ?? { candidates: [], target }
        group.candidates.push(candidate)
        groups.set(key, group)
      }
      const readySummary = db.prepare("SELECT 1 FROM conversation_summaries WHERE conversation_id=? AND status='ready'")
      let processed = 0
      const total = candidates.reduce((count, candidate) => count + candidate.counts.validRecords, 0)
      dependencies.progress?.(0, total)
      for (const group of groups.values()) {
        checkSignal(signal)
        candidateId = group.candidates[0].candidateId
        phase = 'save'
        const candidateIds = group.candidates.map(candidate => candidate.candidateId)
        const view = staged.conversation(candidateIds)
        view.decisions = group.candidates.map(candidate => decisions.get(candidate.candidateId)).filter(decision => decision !== undefined)
        const commit = dependencies.commit ?? createCommitter({ progress: count => dependencies.progress?.(processed + count, total) })
        const result = await commit(store, view, group.target, signal)
        checkSignal(signal)
        phase = 'confirm'
        verifyReceipt(store, id, group.candidates, result)
        phase = 'statistics'
        const conversationId = BigInt(result.conversationId)
        if (result.summaryChanged || !readySummary.get(conversationId)) {
          await (dependencies.summary ?? rebuildSummary)(store, result.conversationId)
          if (!readySummary.get(conversationId)) throw new ImportFailure('STATISTICS_FAILED')
        }
        checkSignal(signal)
        processed += result.inserted + result.duplicates
        dependencies.progress?.(processed, total)
        dependencies.changed?.(candidateIds)
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      checkSignal(signal)
      phase = 'save'; candidateId = ''
      setJobState(store, id, 'completed')
      db.exec('COMMIT')
    } catch (error) {
      if (db.inTransaction) {
        try { db.exec('ROLLBACK') }
        catch {
          if (db.inTransaction) db.close()
          throw new ImportFailure('ROLLBACK_STORAGE_ERROR', 'cancel')
        }
        try { db.prepare("UPDATE import_jobs SET metadata=json_set(metadata,'$.rolledBack',json('true')) WHERE id=?").run(BigInt(id)) }
        catch { /* 保留原始导入错误，未写入的撤回状态留为未知。 */ }
      }
      if (!signal.aborted) {
        const code = error instanceof ImportFailure ? error.code
          : storageFailure(error) ? 'STORAGE_UNWRITABLE'
          : phase === 'statistics' ? 'STATISTICS_FAILED' : phase === 'confirm' ? 'SAVE_CONFIRMATION_MISSING' : 'COMMIT_FAILED'
        try { recordImportFailure(store, id, phase, issue(code, candidateId)) }
        catch { throw new ImportFailure(code, phase) }
      }
    }
    if (!signal.aborted) dependencies.changed?.()
  })
}
