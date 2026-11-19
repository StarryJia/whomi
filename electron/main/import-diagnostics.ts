import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importFailurePhases, type ImportCounts, type ImportSnapshot } from '../../src/shared/import-contract'
import type { ImportDiagnostic } from '../../src/shared/import-diagnostics'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'

const importCodes = new Set([
  'ALREADY_COMMITTED', 'AMBIGUOUS_FORMAT', 'AMBIGUOUS_MESSAGE', 'CANCEL_FAILED', 'COMMIT_FAILED', 'CONVERSATION_BLOCKED',
  'CONVERSATION_MISSING', 'DECLARED_COUNT_MISMATCH', 'DEPTH_LIMIT', 'DIRECTORY_CYCLE', 'DISCOVERY_FAILED',
  'DISK_SPACE', 'DUPLICATE_CONVERSATION_KEY', 'ENTRY_LIMIT', 'FILE_LIMIT', 'IMPORT_BUSY', 'IMPORT_FAILED',
  'IMPORT_NOT_FOUND', 'INCOMPLETE_PARSE', 'INTERRUPTED', 'INVALID_ARGUMENT', 'INVALID_CANDIDATE',
  'INVALID_DISCOVERY', 'INVALID_JOB', 'INVALID_MANIFEST', 'INVALID_PLAN', 'INVALID_RECORD', 'INVALID_RESPONSE',
  'INVALID_SELECTION', 'INVALID_SOURCE', 'INVALID_STATE', 'MANIFEST_PATH', 'MEMBER_CONFLICT', 'MEMBER_MISSING',
  'NO_CONVERSATIONS', 'NO_IMPORTABLE_CONVERSATIONS', 'NO_RECOGNIZED_CONVERSATIONS', 'NO_RECOGNIZED_SOURCES', 'NOT_RECOGNIZED',
  'OPERATION_FAILED', 'PICKER_FAILED', 'PATH_ESCAPE', 'RECORD_COUNT_MISMATCH', 'RECORD_LIMIT', 'RECORD_ORDER',
  'ROLLBACK_FAILED', 'ROLLBACK_STORAGE_ERROR', 'SAVE_CONFIRMATION_MISSING', 'SELF_CONFLICT', 'SHARED_INPUT_INVALID', 'SOURCE_CHANGED',
  'SOURCE_UNREADABLE', 'STAGING_FAILED', 'STAGING_PATH', 'STATISTICS_FAILED', 'STORAGE_RESTART_REQUIRED',
  'STORAGE_UNWRITABLE', 'TARGET_CONFLICT', 'TARGET_GROUP_BLOCKED', 'TARGET_REQUIRED', 'UNKNOWN_JOB',
])
const filenamePattern = /^\d{13}-[a-f\d-]{36}-(none|[1-9]\d{0,18})\.txt$/

function readDiagnostic(value: unknown): ImportDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['phase', 'code', 'jobId'].includes(key))) {
    throw new BoundaryError('INVALID_ARGUMENT')
  }
  const { phase, code, jobId } = value as ImportDiagnostic
  if (!importFailurePhases.includes(phase) || typeof code !== 'string' || code.length > 128 || (jobId !== undefined && !localId(jobId))) {
    throw new BoundaryError('INVALID_ARGUMENT')
  }
  return { phase, code: importCodes.has(code) ? code : 'IMPORT_FAILED', jobId }
}

export function snapshotDiagnostic(snapshot: ImportSnapshot): ImportDiagnostic | undefined {
  if (snapshot.status !== 'failed' || !snapshot.failurePhase) return
  return {
    phase: snapshot.failurePhase,
    code: snapshot.issues.find(issue => issue.severity === 'blocking')?.code ?? 'IMPORT_FAILED',
    jobId: snapshot.jobId,
  }
}

export function createImportDiagnostics(userData: string, version: string, openPath: (path: string) => Promise<string>) {
  const directory = join(userData, 'import-errors')
  let queue: Promise<unknown> = Promise.resolve()
  let lastTimestamp = 0
  const recent = new Map<string, string>()

  function schedule<T>(operation: () => Promise<T>) {
    const next = queue.then(operation)
    queue = next.catch(() => {})
    return next
  }

  async function localDirectory(create: boolean) {
    if (create) await mkdir(directory, { recursive: true })
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== join(await realpath(userData), 'import-errors')) {
      throw new Error('Invalid diagnostics directory')
    }
    return directory
  }

  return {
    async report(input: unknown, counts?: ImportCounts) {
      const { phase, code, jobId } = readDiagnostic(input)
      return schedule(async () => {
        const key = `${jobId}:${phase}:${code}`
        const cached = jobId && recent.get(key)
        let pending: string | undefined
        try {
          const root = await localDirectory(true)
          if (cached && (await lstat(join(root, cached)).catch(() => null))?.isFile()) return
          const timestamp = Math.max(Date.now(), lastTimestamp + 1)
          lastTimestamp = timestamp
          const filename = `${timestamp}-${randomUUID()}-${jobId ?? 'none'}.txt`
          pending = join(root, `${filename}.tmp`)
          const record = {
            recordedAt: new Date(timestamp).toISOString(), version, phase, code,
            ...(counts ? { counts: { seen: counts.seen, validRecords: counts.validRecords, invalidRecords: counts.invalidRecords } } : {}),
          }
          await writeFile(pending, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
          await rename(pending, join(root, filename))
          if (jobId) {
            recent.set(key, filename)
            if (recent.size > 100) recent.delete(recent.keys().next().value!)
          }
        } catch {
          if (pending) await unlink(pending).catch(() => {})
          throw new BoundaryError('IMPORT_LOG_WRITE_FAILED', '无法保存错误日志。请检查应用数据目录是否可写。')
        }
      })
    },
    async open(jobId?: unknown) {
      if (jobId !== undefined && jobId !== null && !localId(jobId)) throw new BoundaryError('INVALID_ARGUMENT')
      return schedule(async () => {
        let path: string
        try {
          const root = await localDirectory(false)
          const files = await readdir(root, { withFileTypes: true })
          const filename = files.filter(entry => entry.isFile() && filenamePattern.test(entry.name) &&
            (jobId === undefined || entry.name.endsWith(`-${jobId ?? 'none'}.txt`))).map(entry => entry.name).sort().at(-1)
          if (!filename) throw new Error('Missing diagnostics')
          path = join(root, filename)
          if (!(await lstat(path)).isFile() || await realpath(path) !== join(await realpath(root), filename)) throw new Error('Invalid diagnostics file')
        } catch {
          throw new BoundaryError('IMPORT_LOG_MISSING', '找不到错误日志。')
        }
        try {
          if (await openPath(path)) throw new Error('Native open failed')
        } catch {
          throw new BoundaryError('IMPORT_LOG_OPEN_FAILED', '无法打开错误日志。请检查默认文本查看应用后重试。')
        }
      })
    },
  }
}
