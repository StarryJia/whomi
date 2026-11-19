import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi, DesktopError, ImportPreview, SourceHandle } from '../shared/desktop-api'
import { importJobStates, type ImportCandidateResult, type ImportFailurePhase, type ImportPlan, type ImportSnapshot } from '../shared/import-contract'

const storageKey = 'whomi:import-job'
const terminal = new Set(['completed', 'partially_completed', 'failed', 'cancelled'])
export const isImportActive = (value: ImportSnapshot) => !terminal.has(value.status)
export const isPersistedResult = (value: ImportCandidateResult) =>
  (value.status === 'saved' || value.status === 'duplicate') &&
  typeof value.conversationId === 'string' && value.conversationId.length > 0 &&
  typeof value.committedAt === 'number' && Number.isFinite(value.committedAt)

export const hasConfirmedImport = (snapshot: ImportSnapshot) => snapshot.status === 'completed' &&
  snapshot.results.length > 0 && snapshot.results.every(result => isPersistedResult(result) && !result.summaryFailed)

type ImportFailure = DesktopError & { phase: ImportFailurePhase }

export function importFailureNotice(failure: ImportFailure | null, jobId?: string, logError = '') {
  if (!failure) return null
  return {
    key: `import:${jobId ?? 'source'}:${failure.phase}:${failure.code}`,
    title: logError ? '错误日志不可用' : '导入遇到问题',
    detail: [failure.action, logError].filter(Boolean).join('\n'),
    blocking: true,
  }
}

const fallbacks: Record<ImportFailurePhase, DesktopError> = {
  source: { code: 'SOURCE_UNREADABLE', action: '无法读取聊天来源。' },
  scan: { code: 'NO_IMPORTABLE_CONVERSATIONS', action: '请核对聊天记录的导出格式。' },
  parse: { code: 'STAGING_FAILED', action: '无法读取聊天记录。请核对导出的聊天文件。' },
  save: { code: 'COMMIT_FAILED', action: '无法保存聊天记录。请检查本地存储。' },
  confirm: { code: 'SAVE_CONFIRMATION_MISSING', action: '无法确认聊天记录已保存。' },
  statistics: { code: 'STATISTICS_FAILED', action: '消息数、成员数和起止时间未能保存。请查看错误日志。' },
  cancel: { code: 'CANCEL_FAILED', action: '无法撤回本次导入。请再次点击取消导入。' },
}

export function getSnapshotFailure(snapshot: ImportSnapshot | null): ImportFailure | null {
  if (!snapshot || snapshot.status === 'cancelled') return null
  const statisticsFailed = snapshot.results.some(result => result.summaryFailed)
  if (snapshot.status === 'completed' && !hasConfirmedImport(snapshot)) {
    const phase = statisticsFailed ? 'statistics' : 'confirm'
    return { phase, ...fallbacks[phase] }
  }
  if (snapshot.status === 'awaiting_confirmation' && !snapshot.discovery?.entries.length) {
    return { phase: 'scan', ...fallbacks.scan }
  }
  if (snapshot.status === 'awaiting_commit' && !snapshot.candidates.some(candidate => candidate.status === 'staged')) {
    return { phase: 'parse', ...fallbacks.parse }
  }
  if (snapshot.status !== 'failed' && snapshot.status !== 'partially_completed') return null

  const phase = snapshot.failurePhase ?? (statisticsFailed ? 'statistics'
    : snapshot.results.some(result => result.status === 'blocked') ? 'parse' : 'save')
  const issues = [...snapshot.issues, ...(snapshot.discovery?.issues ?? []), ...snapshot.results.flatMap(result => result.issues)]
    .filter(issue => issue.severity === 'blocking')
  const issue = issues.find(issue => issue.ordinal !== undefined) ?? issues[0]
  if ((phase === 'scan' || phase === 'statistics') && issue?.code === fallbacks[phase].code) return { phase, ...fallbacks[phase] }
  return { phase, ...(issue ? { code: issue.code, action: issue.action } : fallbacks[phase]) }
}

export function importError(value: unknown): DesktopError {
  if (value && typeof value === 'object' && 'code' in value && 'action' in value &&
    typeof value.code === 'string' && typeof value.action === 'string') return { code: value.code, action: value.action }
  return { code: 'OPERATION_FAILED', action: '操作失败，请重试。' }
}

function phaseError(phase: ImportFailurePhase, value: unknown): ImportFailure {
  const error = importError(value)
  return { phase, ...(error.code === 'OPERATION_FAILED' ? fallbacks[phase] : error) }
}

function remember(id: string | null) {
  try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey) } catch { /* 存储不可用时仍允许当前导入。 */ }
}

export function useImport(api?: DesktopApi) {
  const [snapshot, setSnapshot] = useState<ImportSnapshot | null>(null)
  const [error, setError] = useState<DesktopError | null>(null)
  const [operationFailure, setOperationFailure] = useState<ImportFailure | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [openingLog, setOpeningLog] = useState(false)
  const [logError, setLogError] = useState('')
  const picker = useRef(false)
  const opening = useRef(false)
  const report = useRef<{ key: string; done: Promise<boolean> } | null>(null)
  const session = useRef({
    alive: false, generation: 0, jobId: null as string | null, snapshot: null as ImportSnapshot | null,
    busy: false, cancelling: false, preparing: false, operation: 0, events: new Map<string, ImportSnapshot>(), eventVersion: 0,
  })
  const failure = operationFailure ?? getSnapshotFailure(snapshot)
  const failurePhase = failure?.phase
  const failureCode = failure?.code
  const failedJobId = snapshot?.jobId ?? session.current.jobId ?? undefined
  const failureKey = failure && JSON.stringify([failedJobId, failurePhase, failureCode])

  const accept = useCallback((value: ImportSnapshot) => {
    const current = session.current
    if (!current.alive || current.jobId !== value.jobId) return
    if (current.snapshot?.status === 'cancelled' && value.status !== 'cancelled') return
    // 查询和节流通知可能交错，活动任务不能退回较早阶段。
    if (current.snapshot?.jobId === value.jobId && isImportActive(value) &&
      importJobStates.indexOf(value.status) < importJobStates.indexOf(current.snapshot.status)) return
    current.snapshot = value
    setSnapshot(value)
    if (value.status === 'cancelled' || hasConfirmedImport(value)) {
      setOperationFailure(null)
      setLogError('')
    }
    if (value.status === 'cancelled') remember(null)
  }, [])

  useEffect(() => {
    const current = session.current
    current.alive = true
    function dispose() {
      current.alive = false
      current.generation++
      current.busy = false
      current.cancelling = false
      current.preparing = false
      current.events.clear()
    }
    if (!api) return dispose
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
      current.busy = true
      setBusy(true)
      const valid = () => current.alive && generation === current.generation
      void api.getImport(stored).then(value => {
        if (valid() && version === current.eventVersion) accept(value)
      }).catch(value => {
        if (!valid() || version !== current.eventVersion) return
        const error = phaseError('confirm', value)
        if (['UNKNOWN_JOB', 'INVALID_JOB', 'IMPORT_NOT_FOUND', 'IMPORT_RESULT_REMOVED', 'INVALID_ARGUMENT'].includes(error.code)) {
          remember(null)
          current.jobId = null
        }
        if (error.code !== 'IMPORT_RESULT_REMOVED') setOperationFailure(error)
      }).finally(() => {
        if (valid()) { current.busy = false; setBusy(false) }
      })
    }
    return () => { dispose(); stop() }
  }, [api, accept])

  const reportFailure = useCallback(() => {
    if (!api?.importDiagnostics || !failureKey || !failurePhase || !failureCode) return
    if (report.current?.key !== failureKey) {
      const attempt = api.importDiagnostics.report({ phase: failurePhase, code: failureCode, ...(failedJobId && { jobId: failedJobId }) })
        .then(() => true, () => {
          if (report.current?.done === attempt) report.current = null
          return false
        })
      report.current = { key: failureKey, done: attempt }
    }
    return report.current.done
  }, [api, failedJobId, failureCode, failureKey, failurePhase])

  useEffect(() => {
    let live = true
    void reportFailure()?.then(written => {
      if (live && !written) setLogError('无法写入错误日志。请检查本地存储。')
    })
    return () => { live = false }
  }, [reportFailure])

  async function refresh(jobId: string, valid: () => boolean) {
    const current = session.current, version = current.eventVersion
    const value = await api!.getImport(jobId)
    if (valid() && version === current.eventVersion) accept(value)
    return current.snapshot
  }

  function canSelect() {
    const current = session.current
    return !!api && current.alive && !current.busy && !failure &&
      (!current.jobId || current.snapshot?.status === 'cancelled')
  }

  async function select(obtain: () => Promise<SourceHandle[]>) {
    if (!api || !canSelect()) return
    const current = session.current, generation = ++current.generation
    const valid = () => current.alive && generation === current.generation
    current.busy = true
    current.jobId = null
    current.snapshot = null
    current.events.clear()
    setBusy(true)
    setSnapshot(null)
    setError(null)
    setOperationFailure(null)
    setLogError('')
    report.current = null
    try {
      const handles = await obtain()
      if (!valid() || !handles.length) return
      current.preparing = true
      const jobId = await api.prepareImport(handles)
      if (!valid()) { await api.cancelImport(jobId); return }
      current.jobId = jobId
      current.preparing = false
      remember(jobId)
      const early = current.events.get(jobId)
      current.events.clear()
      if (early) accept(early)
      await refresh(jobId, valid)
    } catch (cause) {
      if (valid()) setOperationFailure(phaseError(current.jobId ? 'scan' : 'source', cause))
    } finally {
      if (valid()) { current.preparing = false; current.busy = false; setBusy(false) }
    }
  }

  async function choose(kind: 'files' | 'directory') {
    if (!api || picker.current || !canSelect()) return
    const current = session.current, generation = current.generation
    const valid = () => current.alive && generation === current.generation
    picker.current = true
    setPickerOpen(true)
    let handles: SourceHandle[]
    try { handles = await api.chooseSources(kind) }
    catch (cause) {
      if (valid()) {
        const error = importError(cause)
        setOperationFailure(error.code === 'OPERATION_FAILED'
          ? { phase: 'source', code: 'PICKER_FAILED', action: '无法打开选择窗口。' }
          : { phase: 'source', ...error })
      }
      return
    } finally {
      picker.current = false
      if (current.alive) setPickerOpen(false)
    }
    if (valid() && handles.length) await select(async () => handles)
  }

  async function run(phase: 'parse' | 'save', operation: (jobId: string) => Promise<unknown>) {
    const current = session.current, jobId = current.jobId
    if (!api || !jobId || current.busy || failure) return
    const generation = current.generation, sequence = ++current.operation
    const valid = () => current.alive && generation === current.generation && sequence === current.operation
    current.busy = true
    setBusy(true)
    try {
      await operation(jobId)
      if (valid()) await refresh(jobId, valid)
    } catch (cause) {
      if (valid() && !getSnapshotFailure(current.snapshot) &&
        (!current.snapshot || !hasConfirmedImport(current.snapshot))) setOperationFailure(phaseError(phase, cause))
    } finally {
      if (valid()) { current.busy = false; setBusy(false) }
    }
  }

  async function preview(candidateId: string, afterOrdinal?: number): Promise<ImportPreview | null> {
    const current = session.current, generation = current.generation, jobId = current.jobId
    if (!api || !jobId) return null
    setError(null)
    try {
      const page = await api.previewImport(jobId, candidateId, { ...(afterOrdinal === undefined ? {} : { afterOrdinal }), limit: 50 })
      return current.alive && generation === current.generation ? page : null
    } catch (cause) {
      if (current.alive && generation === current.generation) setError(importError(cause))
      return null
    }
  }

  const reset = useCallback(() => {
    const current = session.current
    current.generation++
    current.jobId = null
    current.snapshot = null
    current.busy = false
    current.cancelling = false
    current.preparing = false
    current.events.clear()
    report.current = null
    opening.current = false
    setSnapshot(null)
    setError(null)
    setOperationFailure(null)
    setLogError('')
    setOpeningLog(false)
    setBusy(false)
    setCancelling(false)
    remember(null)
  }, [])

  async function cancel() {
    const current = session.current, jobId = current.jobId
    if (!api || current.cancelling) return
    if (!jobId) {
      if (failure) reset()
      return
    }
    const generation = current.generation, sequence = ++current.operation
    const valid = () => current.alive && generation === current.generation && sequence === current.operation
    const settled = () => !!current.snapshot && (current.snapshot.status === 'cancelled' || hasConfirmedImport(current.snapshot))
    current.busy = true
    current.cancelling = true
    setBusy(true)
    setCancelling(true)
    let requestFailure: ImportFailure | undefined
    try {
      try { await api.cancelImport(jobId) }
      catch (cause) { requestFailure = phaseError('cancel', cause) }
      if (!valid() || settled()) return
      const value = await refresh(jobId, valid)
      if (!valid() || settled()) return
      // 旧版部分完成没有整批事务，已提交的历史数据仍可继续使用。
      if (!requestFailure && value?.status === 'partially_completed' && !value.failurePhase && value.results.some(isPersistedResult)) {
        reset()
        return
      }
      setOperationFailure(requestFailure ?? { phase: 'cancel', ...fallbacks.cancel })
    } catch (cause) {
      if (valid() && !settled()) setOperationFailure(requestFailure ?? phaseError('cancel', cause))
    } finally {
      if (valid()) {
        current.busy = false
        current.cancelling = false
        setBusy(false)
        setCancelling(false)
      }
    }
  }

  async function openErrorLog() {
    if (!failureKey || opening.current) return
    const diagnostics = api?.importDiagnostics
    if (!diagnostics) { setLogError('无法打开错误日志。'); return }
    const current = session.current, generation = current.generation
    const valid = () => current.alive && current.generation === generation
    opening.current = true
    setOpeningLog(true)
    setLogError('')
    try {
      const written = reportFailure()
      if (written && !await written) {
        if (valid()) setLogError('无法写入错误日志。请检查本地存储。')
        return
      }
      if (valid() && !(current.snapshot && (current.snapshot.status === 'cancelled' || hasConfirmedImport(current.snapshot)))) {
        await diagnostics.open(failedJobId ?? null)
      }
    } catch (cause) {
      if (valid()) {
        const error = importError(cause)
        setLogError(error.code === 'OPERATION_FAILED' ? '无法打开错误日志。' : error.action)
      }
    } finally {
      if (valid()) {
        opening.current = false
        setOpeningLog(false)
      }
    }
  }

  return {
    snapshot, error: operationFailure ?? error, failure, failedJobId, busy, pickerOpen, cancelling, openingLog, logError,
    choose, drop: (files: File[]) => select(() => api!.acceptDroppedFiles(files)), cancel, preview, reset, openErrorLog,
    stage: (entryIds: string[]) => run('parse', jobId => api!.startImport({ kind: 'stage', jobId, entryIds })),
    commit: (decisions: ImportPlan['decisions'], candidateIds?: string[]) => run('save', jobId => api!.startImport({
      kind: 'commit', plan: { jobId, decisions, ...(candidateIds && { candidateIds }) },
    })),
  }
}
