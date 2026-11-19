import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { importFailurePhases, type ImportCounts, type ImportSnapshot } from '../../src/shared/import-contract'
import { currentImportIssue, type ImportDiagnostic } from '../../src/shared/import-diagnostics'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import { localLogDirectory, logPathKey, writeLocalLog, type createAppErrorLogs } from './app-error-logs'

const parserCodes = new Set([
  'CANCELLED', 'DECLARED_COUNT_MISMATCH', 'FILE_LIMIT', 'INCOMPLETE_PARSE', 'INVALID_DECLARED_COUNT',
  'INVALID_FORMAT', 'INVALID_HEADER', 'INVALID_RECORD', 'JSON_DEPTH', 'MANIFEST_PATH', 'MISSING_CONVERSATIONS',
  'MISSING_FIELDS', 'MISSING_MESSAGES', 'RECORD_COUNT_MISMATCH', 'RECORD_LIMIT', 'UNSAFE_NUMBER',
  'UNSAFE_PROPERTY', 'UNSUPPORTED_VERSION', 'UPSTREAM_ERROR',
])
const legacyGenericCodes = new Set([...parserCodes, 'TAKEOUT_INCOMPLETE', 'STAGING_CLOSED', 'INVALID_PAGE', 'PREVIEW_UNAVAILABLE'])
const importCodes = new Set([
  ...legacyGenericCodes,
  'ALREADY_COMMITTED', 'AMBIGUOUS_FORMAT', 'AMBIGUOUS_MESSAGE', 'CANCEL_FAILED', 'COMMIT_FAILED', 'CONVERSATION_BLOCKED',
  'CONVERSATION_MISSING', 'DEPTH_LIMIT', 'DIRECTORY_CYCLE', 'DISCOVERY_FAILED',
  'DISK_SPACE', 'DUPLICATE_CONVERSATION_KEY', 'ENTRY_LIMIT', 'IMPORT_BUSY', 'IMPORT_FAILED',
  'IMPORT_NOT_FOUND', 'INTERRUPTED', 'INVALID_ARGUMENT', 'INVALID_CANDIDATE',
  'INVALID_DISCOVERY', 'INVALID_JOB', 'INVALID_MANIFEST', 'INVALID_PLAN', 'INVALID_RESPONSE',
  'INVALID_SELECTION', 'INVALID_SOURCE', 'INVALID_STATE', 'MEMBER_CONFLICT', 'MEMBER_MISSING',
  'NO_CONVERSATIONS', 'NO_IMPORTABLE_CONVERSATIONS', 'NO_RECOGNIZED_CONVERSATIONS', 'NO_RECOGNIZED_SOURCES', 'NOT_RECOGNIZED',
  'OPERATION_FAILED', 'PICKER_FAILED', 'PATH_ESCAPE', 'RECORD_ORDER',
  'ROLLBACK_FAILED', 'ROLLBACK_STORAGE_ERROR', 'SAVE_CONFIRMATION_MISSING', 'SELF_CONFLICT', 'SHARED_INPUT_INVALID', 'SOURCE_CHANGED',
  'SOURCE_UNREADABLE', 'STAGING_FAILED', 'STAGING_PATH', 'STATISTICS_FAILED', 'STORAGE_RESTART_REQUIRED',
  'STORAGE_UNWRITABLE', 'TARGET_CONFLICT', 'TARGET_GROUP_BLOCKED', 'TARGET_REQUIRED', 'UNKNOWN_JOB',
])
const filenamePattern = /^(\d{13})-[a-f\d-]{36}-(?:(\d{1,16})-)?(none|[1-9]\d{0,18})\.txt$/
type LogRecord = { recordedAt: string; version: string; phase: ImportDiagnostic['phase']; code: string; counts?: ImportCounts }
type LogFile = { root: string; name: string; recordedAt: number; jobId: string; jobCreatedAt?: number }
type LogIndex = { files: LogFile[]; byJob: Map<string, LogFile[]> }

function readDiagnostic(value: unknown): ImportDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['phase', 'code', 'jobId'].includes(key))) {
    throw new BoundaryError('INVALID_ARGUMENT')
  }
  const { phase, code, jobId } = value as ImportDiagnostic
  if (!importFailurePhases.includes(phase) || typeof code !== 'string' || code.length > 128 || (jobId !== undefined && !localId(jobId))) {
    throw new BoundaryError('INVALID_ARGUMENT')
  }
  const normalized = code.toUpperCase().replaceAll('-', '_')
  return { phase, code: importCodes.has(normalized) ? normalized : 'IMPORT_FAILED', jobId }
}

export function snapshotDiagnostic(snapshot: ImportSnapshot): ImportDiagnostic | undefined {
  if (snapshot.status !== 'failed' || !snapshot.failurePhase) return
  return {
    phase: snapshot.failurePhase,
    code: currentImportIssue(snapshot.failurePhase, snapshot.issues)?.code ?? 'IMPORT_FAILED',
    jobId: snapshot.jobId,
  }
}

function safeCounts(counts?: ImportCounts): ImportCounts | undefined {
  if (counts && [counts.seen, counts.validRecords, counts.invalidRecords].every(n => Number.isSafeInteger(n) && n >= 0)) {
    return { seen: counts.seen, validRecords: counts.validRecords, invalidRecords: counts.invalidRecords }
  }
}

function isDifferentLegacyJob(file: LogFile, stored?: ImportCounts, counts?: ImportCounts) {
  return file.jobCreatedAt === undefined && stored && counts &&
    (stored.seen !== counts.seen || stored.validRecords !== counts.validRecords || stored.invalidRecords !== counts.invalidRecords)
}

function indexFile(index: LogIndex, file: LogFile) {
  index.files.push(file)
  const job = index.byJob.get(file.jobId)
  if (job) job.push(file)
  else index.byJob.set(file.jobId, [file])
}

function addFile(index: LogIndex, root: string, name: string) {
  const match = filenamePattern.exec(name)
  if (!match) return
  const [, recordedAt, createdAt, jobId] = match
  indexFile(index, { root, name, jobId, recordedAt: Number(recordedAt), jobCreatedAt: createdAt === undefined ? undefined : Number(createdAt) })
}

async function indexLogs(root: string): Promise<LogIndex> {
  const index: LogIndex = { files: [], byJob: new Map() }
  const names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort()
  for (const name of names) addFile(index, root, name)
  return index
}

function belongsToJob(file: LogFile, jobCreatedAt?: number) {
  // 旧版文件名没有任务创建时间，早于本批开始的日志属于其他任务。
  if (file.jobCreatedAt === undefined) return jobCreatedAt === undefined || file.recordedAt >= jobCreatedAt
  return file.jobCreatedAt === jobCreatedAt
}

async function checkedFile(root: string, filename: string) {
  const path = join(root, filename)
  const info = await lstat(path)
  const canonical = await realpath(path)
  if (!info.isFile() || info.nlink !== 1 || logPathKey(canonical) !== logPathKey(path)) throw new Error('Invalid diagnostics file')
  return { path, size: info.size }
}

async function readRecord(root: string, filename: string): Promise<LogRecord | undefined> {
  try {
    const { path, size } = await checkedFile(root, filename)
    if (size > 4096) return
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value.recordedAt !== 'string' || typeof value.version !== 'string'
      || !importFailurePhases.includes(value.phase) || !importCodes.has(value.code)) return
    return { recordedAt: value.recordedAt, version: value.version, phase: value.phase, code: value.code, counts: safeCounts(value.counts) }
  } catch { return }
}

async function originalRecord(index: LogIndex, jobId: string, jobCreatedAt: number | undefined, phase: ImportDiagnostic['phase'], code: string, counts?: ImportCounts) {
  let original: { file: LogFile; record: LogRecord } | undefined
  const quality = (record: LogRecord) => Number(record.code !== 'IMPORT_FAILED') * 2 + Number(!!record.counts)
  for (const file of index.byJob.get(jobId) ?? []) {
    if (original && file.name !== original.file.name) break
    if (!belongsToJob(file, jobCreatedAt)) continue
    const record = await readRecord(file.root, file.name)
    if (!record || record.phase !== phase || isDifferentLegacyJob(file, record.counts, counts)) continue
    // 旧版用通用代码保存过这些导入错误。
    const legacy = (record.code === 'IMPORT_FAILED' && legacyGenericCodes.has(code))
      || (code === 'IMPORT_FAILED' && legacyGenericCodes.has(record.code))
    if ((record.code === code || legacy) && (!original || quality(record) > quality(original.record))) original = { file, record }
  }
  return original
}

async function latestLog(index: LogIndex, jobId?: unknown, job?: ImportSnapshot) {
  const jobCreatedAt = job?.jobCreatedAt
  const files = jobId === undefined ? index.files : index.byJob.get(String(jobId ?? 'none')) ?? []
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i]
    if (jobCreatedAt !== undefined && !belongsToJob(file, jobCreatedAt)) continue
    const entry = await checkedFile(file.root, file.name).catch(() => undefined)
    if (!entry) continue
    if (file.jobId === 'none') return entry
    const record = await readRecord(file.root, file.name)
    if (record && isDifferentLegacyJob(file, record.counts, job?.counts)) continue
    const original = record && await originalRecord(index, file.jobId, file.jobCreatedAt ?? jobCreatedAt, record.phase, record.code, record.counts)
    if (!original || original.file === file) return entry
  }
}

export function createImportDiagnostics(userData: string, version: string, openPath: (path: string) => Promise<string>,
  getImport?: (jobId: string) => Promise<ImportSnapshot>,
  logs?: Pick<ReturnType<typeof createAppErrorLogs>, 'withWritableRoot' | 'importDirectories'>) {
  const directory = join(resolve(userData), 'import-errors')
  let queue: Promise<unknown> = Promise.resolve()
  const indexes = new Map<string, LogIndex>()

  function schedule<T>(operation: () => Promise<T>) {
    const next = queue.then(operation)
    queue = next.catch(() => {})
    return next
  }

  const readDirectories = () => logs?.importDirectories() ?? [directory]
  async function combinedIndex(locations: string[], jobId: string | undefined, fresh: boolean) {
    const files: LogFile[] = []
    const seen = new Set<string>()
    for (const location of locations) {
      const key = logPathKey(location)
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const root = await localLogDirectory(location)
        const index = (!fresh && indexes.get(root)) || await indexLogs(root)
        indexes.set(root, index)
        for (const file of jobId === undefined ? index.files : index.byJob.get(jobId) ?? []) files.push(file)
      } catch { /* 目录不可读时继续查找其他位置。 */ }
    }
    const index: LogIndex = { files: [], byJob: new Map() }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) indexFile(index, file)
    return index
  }

  return {
    async report(input: unknown, counts?: ImportCounts, jobCreatedAt?: number) {
      const request = readDiagnostic(input)
      return schedule(async () => {
        const { phase, jobId } = request
        let code = request.code
        if (!counts && jobId && getImport) {
          const snapshot = await getImport(jobId).catch(() => undefined)
          if (snapshot?.jobId === jobId) {
            counts = snapshot.counts
            jobCreatedAt = snapshot.jobCreatedAt
            const failure = snapshotDiagnostic(snapshot)
            if (failure?.phase === phase) code = readDiagnostic(failure).code
          }
        }
        const write = async (root: string) => {
          const index = indexes.get(root) ?? await indexLogs(root)
          indexes.set(root, index)
          // 升级回放或更换保存目录后，同一失败仍沿用最早的记录。
          const original = jobId ? await originalRecord(await combinedIndex([root, ...readDirectories()], jobId, false),
            jobId, jobCreatedAt, phase, code, counts) : undefined
          const existing = original?.record
          const recordedCounts = existing?.counts ?? safeCounts(counts)
          const recordedCode = existing && existing.code !== 'IMPORT_FAILED' ? existing.code : code
          if (existing && existing.code === recordedCode && (existing.counts || !recordedCounts)) return
          const timestamp = Math.max(Date.now(), (index.files.at(-1)?.recordedAt ?? 0) + 1)
          const scope = jobId && jobCreatedAt !== undefined ? `${jobCreatedAt}-` : ''
          const filename = original?.file.name ?? `${timestamp}-${randomUUID()}-${scope}${jobId ?? 'none'}.txt`
          const record: LogRecord = { recordedAt: existing?.recordedAt ?? new Date(timestamp).toISOString(),
            version: existing?.version ?? version, phase, code: recordedCode, counts: recordedCounts }
          await writeLocalLog(root, filename, record)
          if (!original) addFile(index, root, filename)
          else if (original.file.root !== root) indexes.delete(root)
        }
        try {
          if (logs) await logs.withWritableRoot(async root => write(await localLogDirectory(join(root, 'import-errors'), true)))
          else await write(await localLogDirectory(directory, true))
        } catch {
          throw new BoundaryError('IMPORT_LOG_WRITE_FAILED', '无法保存错误日志。请检查应用数据目录是否可写。')
        }
      })
    },
    async open(jobId?: unknown) {
      if (jobId !== undefined && jobId !== null && !localId(jobId)) throw new BoundaryError('INVALID_ARGUMENT')
      return schedule(async () => {
        const job = typeof jobId === 'string' && getImport ? await getImport(jobId).catch(() => undefined) : undefined
        const index = await combinedIndex(readDirectories(), jobId === undefined ? undefined : String(jobId ?? 'none'), true)
        const file = await latestLog(index, jobId, job)
        if (!file) throw new BoundaryError('IMPORT_LOG_MISSING', '找不到错误日志。')
        try {
          if (await openPath(file.path)) throw new Error('Native open failed')
        } catch {
          throw new BoundaryError('IMPORT_LOG_OPEN_FAILED', '无法打开错误日志。请检查默认文本查看应用后重试。')
        }
      })
    },
    flush: () => queue,
  }
}
