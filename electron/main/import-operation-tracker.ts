import type { SourceHandle } from '../../src/shared/desktop-api'
import type { ImportSnapshot, StartImportRequest } from '../../src/shared/import-contract'
import { importSnapshotStates, terminalImportStates } from '../../src/shared/import-contract'
import { currentImportIssue } from '../../src/shared/import-diagnostics'
import type { createOperationDiagnostics } from './operation-diagnostics'

type Diagnostics = Pick<ReturnType<typeof createOperationDiagnostics>, 'begin' | 'event' | 'end' | 'bind' | 'findByTask' | 'list' | 'resume'>
type ImportTrace = {
  jobId?: string
  createdAt?: number
  lastStatus?: ImportSnapshot['status']
  lastCounts?: string
  lastFailure?: string
  candidates?: number
  saved?: 'success' | 'cancelled'
  priorFailure?: 'failed' | 'interrupted'
  ended?: boolean
  awaitingReceipt?: boolean
}

function errorCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
    ? cause.code.toUpperCase().replaceAll('-', '_') : 'OPERATION_FAILED'
}

function snapshotFailure(snapshot: ImportSnapshot) {
  if (snapshot.status !== 'failed' && snapshot.status !== 'partially_completed') return
  const phase = snapshot.failurePhase ?? 'save'
  const code = (currentImportIssue(phase, snapshot.issues)?.code ?? 'IMPORT_FAILED').toUpperCase().replaceAll('-', '_')
  return { phase, code, signature: phase + ':' + code }
}

export function createImportOperationTracker(log: Diagnostics) {
  const active = new Map<string, ImportTrace>()
  const jobs = new Map<string, string>()

  function begin(handles: SourceHandle[], source: 'picker' | 'drop') {
    for (const [oldId, trace] of active) if (trace.ended && (!trace.awaitingReceipt || !trace.jobId)) forget(oldId)
    const id = log.begin('import', 'import')
    const kinds = new Set(handles.map(handle => handle.kind))
    log.event(id, 'accepted', { source, sourceKind: kinds.size === 1 ? handles[0].kind : 'mixed', sourceCount: handles.length })
    log.event(id, 'prepare', { result: 'requested' })
    active.set(id, {})
    return id
  }

  function forget(id: string) {
    const trace = active.get(id)
    if (trace?.jobId && jobs.get(trace.jobId) === id) jobs.delete(trace.jobId)
    active.delete(id)
  }
  function prepareFailed(id: string, cause: unknown) {
    const trace = active.get(id)
    if (!trace || trace.ended || trace.saved) return
    const code = errorCode(cause)
    if (['SERVICE_UNAVAILABLE', 'DATA_PROCESS_GONE', 'INVALID_RESPONSE'].includes(code)) {
      log.event(id, 'prepare', { result: 'unknown', code })
      log.end(id, 'unknown', { code })
      trace.ended = true
      trace.awaitingReceipt = true
    } else {
      log.end(id, 'failed', { code })
      forget(id)
    }
  }

  function observe(snapshot: ImportSnapshot) {
    const id = snapshot.operationId
    const trace = id && active.get(id)
    if (!id || !trace) return
    if (!trace.jobId && snapshot.jobCreatedAt !== undefined) {
      trace.jobId = snapshot.jobId
      trace.createdAt = snapshot.jobCreatedAt
      jobs.set(snapshot.jobId, id)
      log.bind(id, snapshot.jobId, snapshot.jobCreatedAt)
    }
    const { status, counts, progress, discovery } = snapshot
    if (trace.lastStatus && importSnapshotStates.indexOf(status) < importSnapshotStates.indexOf(trace.lastStatus)) return
    const failure = snapshotFailure(snapshot)
    const changed = trace.lastStatus !== status || failure?.signature !== trace.lastFailure
    const fields = { validRecords: counts.validRecords, invalidRecords: counts.invalidRecords, processed: progress?.processed, total: progress?.total }
    const signature = JSON.stringify(fields)
    if (!changed && (trace.lastCounts === signature || !['staging','committing'].includes(status))) return
    if (trace.awaitingReceipt) {
      if (!terminalImportStates.has(status)) return
      log.resume(id)
      trace.awaitingReceipt = false
      trace.ended = false
    }
    trace.lastStatus = status
    trace.lastFailure = failure?.signature
    trace.lastCounts = signature
    const scan = { fileCount: discovery?.fileCount, totalBytes: discovery?.totalBytes }
    if (status === 'scanning') log.event(id, 'scan', { result: 'requested' })
    if (status === 'awaiting_confirmation' || (status === 'failed' && snapshot.failurePhase === 'scan')) {
      log.event(id, 'scan', { ...scan, result: status === 'failed' ? 'failed' : 'success' })
    }
    if (status === 'staging' || status === 'committing') {
      log.event(id, status === 'staging' ? 'parse' : 'commit', fields, { progress: !changed })
    }
    if (status === 'awaiting_commit' || (status === 'failed' && snapshot.failurePhase === 'parse')) {
      trace.candidates = snapshot.candidates.length
      log.event(id, 'parse', { ...fields, recognizedCount: trace.candidates, result: status === 'failed' ? 'failed' : 'success' })
      const groups = new Map<string, { count: number; ordinals: number[] }>()
      // 解析阶段已按候选会话归并；任务和结果中有同一异常的副本。
      for (const candidate of snapshot.candidates) for (const issue of candidate.issues) {
        const group = groups.get(issue.code) ?? { count: 0, ordinals: [] }
        group.count += issue.occurrences ?? 1
        const samples = issue.ordinals ?? (issue.ordinal === undefined ? [] : [issue.ordinal])
        group.ordinals.push(...samples.slice(0, 3 - group.ordinals.length))
        groups.set(issue.code, group)
      }
      for (const [code, group] of groups) log.event(id, 'issues', { code: code.toUpperCase().replaceAll('-', '_'), count: group.count,
        ...(group.ordinals.length && { ordinals: group.ordinals }) })
    }
    if (status === 'completed') {
      const persisted = snapshot.results.filter(row => row.committedAt !== null && row.conversationId && ['saved','duplicate'].includes(row.status))
      const confirmed = persisted.length > 0 && persisted.length === snapshot.results.length && persisted.every(row => !row.summaryFailed)
      const created = new Set(persisted.filter(row => row.matchedConversationTitle === undefined).map(row => row.conversationId))
      const existing = new Set(persisted.filter(row => row.matchedConversationTitle !== undefined).map(row => row.conversationId))
      log.event(id, 'commit', { result: confirmed ? 'success' : 'unknown', newCount: created.size, appendCount: existing.size, inserted: snapshot.inserted, duplicates: snapshot.duplicates })
      if (confirmed) trace.saved = 'success'
      else { log.end(id, 'unknown', { code: 'SAVE_CONFIRMATION_MISSING' }); forget(id) }
    }
    if (status === 'cancelled') {
      log.event(id, 'rollback', { result: 'success', inserted: snapshot.inserted, duplicates: snapshot.duplicates })
      trace.saved = 'cancelled'
    }
    if (failure) {
      const { phase, code } = failure
      const stage = phase === 'source' ? 'prepare' : phase === 'cancel' ? 'rollback' : phase === 'scan' || phase === 'parse' ? phase : 'commit'
      log.event(id, stage, { result: 'failed', phase, code, ...fields })
      if (snapshot.rolledBack && phase !== 'cancel') log.event(id, 'rollback', { result: 'success', inserted: snapshot.inserted })
      trace.priorFailure = code === 'INTERRUPTED' ? 'interrupted' : 'failed'
      log.end(id, trace.priorFailure, { code })
      trace.ended = true
    }
  }

  async function recover(snapshot: ImportSnapshot) {
    if (snapshot.operationId && !active.has(snapshot.operationId) && terminalImportStates.has(snapshot.status) && snapshot.status !== 'removed') {
      const id = snapshot.operationId
      const entry = (await log.list()).find(operation => operation.id === id)
      if (!entry || active.has(id)) return
      const failure = snapshotFailure(snapshot)
      const interruptionRecorded = entry.outcome === 'interrupted' && entry.endCode === 'INTERRUPTED'
      if (failure?.code === 'INTERRUPTED' && !interruptionRecorded && ['unknown','running','interrupted','failed'].includes(entry.outcome)) {
        log.resume(id)
        log.event(id, 'recovery', { result: 'interrupted', code: 'INTERRUPTED' })
        active.set(id, {})
      } else if (entry.outcome === 'unknown' || (snapshot.status !== 'failed' && entry.outcome === 'interrupted')) {
        log.resume(id)
        active.set(id, {})
      } else if (snapshot.status === 'failed' && (entry.outcome === 'failed' || entry.outcome === 'interrupted')) {
        active.set(id, { jobId: snapshot.jobId, createdAt: snapshot.jobCreatedAt, priorFailure: entry.outcome, lastStatus: 'failed',
          lastFailure: failure?.signature, ended: true })
        jobs.set(snapshot.jobId, id)
        return
      }
    }
    observe(snapshot)
  }

  function requested(request: StartImportRequest | string) {
    const jobId = typeof request === 'string' ? request : request.kind === 'stage' ? request.jobId : request.plan.jobId
    const id = jobs.get(jobId)
    if (!id) return
    if (typeof request === 'string') {
      const trace = active.get(id)
      if (trace?.ended) {
        log.resume(id)
        trace.ended = false
        trace.awaitingReceipt = false
      }
      log.event(id, 'rollback', { result: 'requested' })
    }
    else if (request.kind === 'stage') log.event(id, 'parse', { result: 'requested', count: request.entryIds.length })
    else {
      log.event(id, 'selection', { selectedCount: request.plan.candidateIds?.length ?? active.get(id)?.candidates })
      log.event(id, 'commit', { result: 'requested' })
    }
  }

  function requestFailed(request: StartImportRequest | string, cause: unknown) {
    const cancelling = typeof request === 'string'
    const jobId = cancelling ? request : request.kind === 'stage' ? request.jobId : request.plan.jobId
    const id = jobs.get(jobId)
    const trace = id && active.get(id)
    if (!id || !trace || trace.ended || trace.saved) return
    const code = errorCode(cause)
    if (cancelling && code === 'CANCEL_FAILED') {
      log.event(id, 'rollback', { result: 'failed', phase: 'cancel', code })
      log.end(id, 'failed', { code })
      trace.lastStatus = 'failed'
      trace.lastFailure = 'cancel:' + code
      trace.priorFailure = 'failed'
      trace.ended = true
      return
    }
    log.event(id, 'requestFailed', { code })
    log.event(id, cancelling ? 'rollback' : request.kind === 'stage' ? 'parse' : 'commit', { result: 'unknown', code })
    trace.ended = true
    trace.awaitingReceipt = true
    log.end(id, trace.priorFailure ?? 'unknown', { code })
  }

  async function forImport(jobId: string, createdAt?: number) {
    const id = jobs.get(jobId)
    if (id && (createdAt === undefined || active.get(id)?.createdAt === createdAt)) return id
    return createdAt === undefined ? null : log.findByTask('import', jobId, createdAt)
  }

  async function refresh(jobId: string, createdAt: number | undefined, result: 'success' | 'failed' | 'unknown') {
    const id = await forImport(jobId, createdAt)
    const saved = id && active.get(id)?.saved
    if (!id || !saved) return
    log.event(id, 'refresh', { result })
    log.end(id, active.get(id)?.priorFailure ?? (result === 'success' ? saved : result))
    forget(id)
  }
  return { begin, prepareFailed, observe, recover, requested, requestFailed, forImport, refresh }
}

export type ImportOperationTracker = ReturnType<typeof createImportOperationTracker>
