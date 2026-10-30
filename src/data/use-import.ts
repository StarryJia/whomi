import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi, DesktopError, ImportPreview, SourceHandle } from '../shared/desktop-api'
import { importJobStates, type ImportCandidateResult, type ImportSnapshot, type TargetDecision } from '../shared/import-contract'

const storageKey = 'whomi:import-job'
const terminal = new Set(['completed', 'partially_completed', 'failed', 'cancelled'])
export const isImportActive = (value: ImportSnapshot) => !terminal.has(value.status)
export const isPersistedResult = (value: ImportCandidateResult) =>
  (value.status === 'saved' || value.status === 'duplicate') && value.conversationId !== null && value.committedAt !== null

export function importError(value: unknown): DesktopError {
  if (value && typeof value === 'object' && 'code' in value && 'action' in value &&
    typeof value.code === 'string' && typeof value.action === 'string') return { code: value.code, action: value.action }
  return { code: 'OPERATION_FAILED', action: '操作失败，请重试。' }
}
function remember(id: string | null) {
  try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey) } catch { /* 存储不可用时仍允许当前导入。 */ }
}

export function useImport(api?: DesktopApi) {
  const [snapshot, setSnapshot] = useState<ImportSnapshot | null>(null)
  const [error, setError] = useState<DesktopError | null>(null)
  const [busy, setBusy] = useState(false)
  const [retriedSummaries, setRetriedSummaries] = useState<ReadonlySet<string>>(new Set())
  const selectionTail = useRef(Promise.resolve())
  const session = useRef({ alive: false, generation: 0, jobId: null as string | null, snapshot: null as ImportSnapshot | null,
    preparing: false, events: new Map<string, ImportSnapshot>(), eventVersion: 0 })

  const accept = useCallback((value: ImportSnapshot) => {
    const current = session.current
    if (!current.alive || current.jobId !== value.jobId) return
    // 查询和节流通知可能交错，同一任务不能退回已经结束的阶段。
    if (current.snapshot?.jobId === value.jobId && importJobStates.indexOf(value.status) < importJobStates.indexOf(current.snapshot.status)) return
    current.snapshot = value
    setSnapshot(value)
    if (value.status === 'cancelled' && !value.results.some(isPersistedResult)) {
      remember(null)
    }
  }, [])

  useEffect(() => {
    const current = session.current
    current.alive = true
    if (!api) return () => { current.alive = false; current.generation++ }
    const stop = api.onImport(value => {
      if (!current.alive) return
      if (current.jobId === value.jobId) { current.eventVersion++; accept(value) }
      else if (current.preparing) current.events.set(value.jobId, value)
    })
    let stored: string | null = null
    try { stored = localStorage.getItem(storageKey) } catch { /* 无存储时无需恢复。 */ }
    if (stored) {
      const generation = ++current.generation
      const version = current.eventVersion
      current.jobId = stored
      setBusy(true)
      void api.getImport(stored).then(value => {
        if (current.alive && generation === current.generation && version === current.eventVersion) {
          accept(value)
        }
      }).catch(value => {
        if (!current.alive || generation !== current.generation) return
        const failure = importError(value)
        if (['UNKNOWN_JOB', 'INVALID_JOB', 'IMPORT_NOT_FOUND', 'INVALID_ARGUMENT'].includes(failure.code)) {
          remember(null); current.jobId = null
        }
        setError(failure)
      }).finally(() => { if (current.alive && generation === current.generation) setBusy(false) })
    }
    return () => { current.alive = false; current.generation++; current.events.clear(); stop() }
  }, [api, accept])

  async function refresh(generation: number, jobId: string) {
    const version = session.current.eventVersion
    const value = await api!.getImport(jobId)
    const current = session.current
    if (current.alive && generation === current.generation && version === current.eventVersion) accept(value)
  }

  async function select(obtain: () => Promise<SourceHandle[]>) {
    if (!api) return
    const current = session.current, generation = ++current.generation
    const valid = () => current.alive && generation === current.generation
    const previous = selectionTail.current
    let release!: () => void
    selectionTail.current = new Promise<void>(resolve => { release = resolve })
    setBusy(true); setError(null)
    try {
      const handles = await obtain()
      // 来源选择可并发完成，但旧准备任务释放后才能创建下一项后台任务。
      await previous
      if (!valid() || !handles.length) return
      if (current.jobId && (!current.snapshot || isImportActive(current.snapshot))) await api.cancelImport(current.jobId)
      if (!valid()) return
      current.jobId = null; current.snapshot = null; current.events.clear(); current.preparing = true
      setSnapshot(null); setRetriedSummaries(new Set())
      const jobId = await api.prepareImport(handles)
      if (!valid()) { await api.cancelImport(jobId); return }
      current.jobId = jobId; current.preparing = false; remember(jobId)
      const early = current.events.get(jobId)
      current.events.clear()
      if (early) accept(early)
      await refresh(generation, jobId)
    } catch (value) { if (valid()) setError(importError(value)) }
    finally { release(); if (valid()) { current.preparing = false; setBusy(false) } }
  }
  async function run(operation: (jobId: string) => Promise<unknown>) {
    const current = session.current, generation = current.generation, jobId = current.jobId
    if (!api || !jobId || busy) return
    setBusy(true); setError(null)
    try { await operation(jobId); await refresh(generation, jobId) }
    catch (value) { if (current.alive && generation === current.generation) setError(importError(value)) }
    finally { if (current.alive && generation === current.generation) setBusy(false) }
  }
  async function preview(candidateId: string, afterOrdinal?: number): Promise<ImportPreview | null> {
    const current = session.current, generation = current.generation, jobId = current.jobId
    if (!api || !jobId) return null
    setError(null)
    try {
      const page = await api.previewImport(jobId, candidateId, { ...(afterOrdinal === undefined ? {} : { afterOrdinal }), limit: 50 })
      return current.alive && generation === current.generation ? page : null
    } catch (value) {
      if (current.alive && generation === current.generation) setError(importError(value))
      return null
    }
  }
  async function retrySummary(id: string) {
    if (!api || !session.current.snapshot?.results.some(r => isPersistedResult(r) && r.conversationId === id)) return
    const current = session.current, generation = current.generation
    setError(null)
    try {
      await api.retrySummary(id)
      if (current.alive && generation === current.generation) setRetriedSummaries(previous => new Set([...previous, id]))
    } catch (value) { if (current.alive && generation === current.generation) setError(importError(value)) }
  }
  const reset = useCallback(() => {
    session.current.jobId = null
    session.current.snapshot = null
    setSnapshot(null)
    setError(null)
    remember(null)
  }, [])
  return { snapshot, error, busy, retriedSummaries,
    choose: (kind: 'files' | 'directory') => select(() => api!.chooseSources(kind)),
    drop: (files: File[]) => select(() => api!.acceptDroppedFiles(files)),
    stage: (entryIds: string[]) => run(jobId => api!.startImport({ kind: 'stage', jobId, entryIds })),
    commit: (decisions: TargetDecision[]) => run(jobId => api!.startImport({ kind: 'commit', plan: { jobId, decisions } })),
    cancel: () => run(jobId => api!.cancelImport(jobId)), preview, retrySummary, reset,
  }
}
