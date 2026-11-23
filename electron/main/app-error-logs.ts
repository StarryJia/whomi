import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import type { ErrorLogLocation } from '../../src/shared/settings-contract'
import type { InsightBudgetLimit } from './insight-checkpoint'

export type AppError = {
  area: 'startup' | 'main' | 'renderer' | 'data' | 'model' | 'conversation' | 'insight'
  phase: string
  error: unknown
  taskId?: string
  analyzedMessages?: number
  budget?: InsightBudgetLimit
}

// 服务商返回的原始错误、请求和界面日志可能包含凭据或聊天正文。
const knownCodes = new Set([
  'AGENT_UNAVAILABLE', 'CONTEXT_TOO_LARGE', 'DATA_PROCESS_GONE', 'DISK_SPACE', 'INSIGHT_BUDGET_EXHAUSTED',
  'INSIGHT_CONTEXT_LIMIT', 'INVALID_EVIDENCE', 'INVALID_INSIGHT_REPORT', 'INVALID_INSIGHT_SNAPSHOT',
  'INVALID_INSIGHT_OUTPUT', 'INVALID_INSIGHT_CHECKPOINT', 'CHATGPT_LIMIT', 'CHATGPT_ACCESS', 'CHATGPT_RECONNECT',
  'CHATGPT_UNSUPPORTED', 'CHATGPT_INELIGIBLE', 'CHATGPT_UNAVAILABLE', 'CHATGPT_REQUEST', 'CHATGPT_INCOMPLETE',
  'CHATGPT_ACCOUNT_CHANGED', 'CHATGPT_BUSY', 'CHATGPT_CALLBACK', 'CHATGPT_CANCELLED', 'CHATGPT_DENIED', 'CHATGPT_IDENTITY',
  'CHATGPT_MODELS', 'CHATGPT_NETWORK', 'CHATGPT_PERMISSION', 'CHATGPT_REVOCATION', 'CHATGPT_TIMEOUT',
  'ACCOUNT_ACCESS', 'ACCOUNT_BUSY', 'ACCOUNT_CANCELLED', 'ACCOUNT_CHANGED', 'ACCOUNT_CLIENT_REQUIRED', 'ACCOUNT_INCOMPLETE',
  'ACCOUNT_LOGIN', 'ACCOUNT_NETWORK', 'ACCOUNT_REQUEST', 'ACCOUNT_REVOCATION', 'ACCOUNT_STORAGE', 'ACCOUNT_TIMEOUT',
  'CODEX_QUOTA_NETWORK', 'CODEX_QUOTA_RESPONSE', 'SESSION_SAVE_FAILED', 'INVALID_CHECKPOINT',
  'INVALID_RESPONSE', 'MAIN_PROCESS_ERROR', 'MODEL_AUTH_FAILED', 'MODEL_CONNECTION_FAILED', 'MODEL_CONTEXT_LIMIT',
  'MODEL_DISABLED', 'MODEL_INPUT_TOO_SMALL', 'MODEL_NOT_FOUND', 'MODEL_OUTPUT_LIMIT', 'MODEL_RATE_LIMIT',
  'MODEL_REQUEST_FAILED', 'MODEL_SYNC_FAILED', 'MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'PRELOAD_ERROR', 'RENDERER_ERROR', 'RENDERER_LOAD_FAILED',
  'RENDERER_PROCESS_GONE', 'SERVICE_UNAVAILABLE', 'STARTUP_FAILED', 'STORAGE_MIGRATION_FAILED',
  'STORAGE_OPEN_FAILED', 'STORAGE_UNAVAILABLE', 'STORAGE_UNWRITABLE',
])

export function isDiagnosticCode(value: unknown): value is string {
  return typeof value === 'string' && (value === 'OPERATION_FAILED' || knownCodes.has(value))
}

export function diagnosticErrorCode(error: unknown) {
  return error instanceof BoundaryError && isDiagnosticCode(error.code) ? error.code : 'OPERATION_FAILED'
}

export function logPathKey(path: string) { return process.platform === 'win32' ? path.toLowerCase() : path }

export async function localLogDirectory(directory: string, create = false) {
  const parent = dirname(directory)
  if (logPathKey(await realpath(parent)) !== logPathKey(parent)) throw new Error('Invalid log directory')
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (!(await lstat(directory)).isDirectory() || logPathKey(await realpath(directory)) !== logPathKey(directory)) {
    throw new Error('Invalid log directory')
  }
  return directory
}

export async function writeLocalLog(root: string, filename: string, record: unknown) {
  const temporary = join(root, `.whomi-${filename}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(root, filename))
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export function createAppErrorLogs(installDirectory: string, userDataPath: string, version: string,
  openPath: (path: string) => Promise<string>, onWriteFailure?: (action: string) => void) {
  const directory = join(resolve(installDirectory), 'logs')
  const profile = resolve(userDataPath)
  const profileLogs = join(profile, 'logs')
  const legacyImport = join(profile, 'import-errors')
  const writeFailureAction = `无法写入安装日志目录 ${directory}。请检查磁盘空间和目录写入权限后重试。`
  let dataLogs = profileLogs
  let retainedDirectories: string[] = []
  let missedRecords = 0
  let writeFailed = false
  let pending = Promise.resolve()
  let diagnostics: {
    writeManagedLog: typeof writeLocalLog
    writeCrashLog: (name: string, text: string, write: () => void) => boolean
  } | undefined

  function recordWriteFailure() {
    missedRecords += 1
    if (!writeFailed) {
      writeFailed = true
      onWriteFailure?.(writeFailureAction)
    }
  }
  function writeLog(root: string, filename: string, record: unknown) {
    return diagnostics ? diagnostics.writeManagedLog(root, filename, record) : writeLocalLog(root, filename, record)
  }

  function schedule<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action)
    pending = next.then(() => {}, () => {})
    return next
  }

  function withWritableRoot<T>(action: (directory: string) => Promise<T>, recording = true) {
    return schedule(async () => {
      try {
        const root = await localLogDirectory(directory, true)
        const probe = join(root, `.${randomUUID()}.tmp`)
        await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
        await unlink(probe)
        const value = await action(root)
        writeFailed = false
        return value
      } catch {
        if (recording) recordWriteFailure()
        throw new BoundaryError('ERROR_LOG_UNWRITABLE', writeFailureAction)
      }
    })
  }

  return {
    writeFailureAction,
    recordWriteFailure, writeLog,
    setOperationDiagnostics(store: typeof diagnostics) { diagnostics = store },
    setWriteFailureListener(listener?: (action: string) => void) {
      if (onWriteFailure === listener) return
      onWriteFailure = listener
      if (writeFailed) listener?.(writeFailureAction)
    },
    setDataArchives(dataDirectory: string, retained: string[] = []) {
      dataLogs = join(resolve(dataDirectory), 'logs')
      retainedDirectories = retained
    },
    withWritableRoot,
    recordMainException(origin: NodeJS.UncaughtExceptionOrigin) {
      // 进程可能在回调返回后立即退出。
      const now = new Date()
      const phase = origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException'
      const record = { recordedAt: now.toISOString(), version, area: 'main', phase, code: 'MAIN_PROCESS_ERROR' }
      try {
        if (logPathKey(realpathSync(dirname(directory))) !== logPathKey(dirname(directory))) return
        try { mkdirSync(directory, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        if (!lstatSync(directory).isDirectory() || logPathKey(realpathSync(directory)) !== logPathKey(directory)) return
        const name = `${now.getTime()}-main-${randomUUID()}.json`
        const text = JSON.stringify(record) + '\n'
        const write = () => writeFileSync(join(directory, name), text, { flag: 'wx', mode: 0o600 })
        if (diagnostics) {
          if (!diagnostics.writeCrashLog(name, text, write)) missedRecords += 1
        } else write()
      } catch { missedRecords += 1 }
    },
    importDirectories: () => [...[directory, dataLogs, profileLogs, ...retainedDirectories].map(root => join(root, 'import-errors')), legacyImport],
    async record({ area, phase, error, taskId, analyzedMessages, budget }: AppError) {
      const code = diagnosticErrorCode(error)
      const id = localId(taskId) ? taskId : undefined
      const now = new Date()
      const filename = [now.getTime(), area, id, randomUUID()].filter(Boolean).join('-') + '.json'
      const record = { recordedAt: now.toISOString(), version, area, phase, code, taskId: id, analyzedMessages, budget }
      return withWritableRoot(async root => {
        await writeLog(root, filename, record)
        return root
      }).catch(() => undefined)
    },
    async open(): Promise<ErrorLogLocation> {
      const location = await withWritableRoot(async path => ({ path, ...(missedRecords > 0 && { missedRecords }) }), false)
      try {
        await localLogDirectory(location.path)
        if (await openPath(location.path)) throw new Error('Native open failed')
      } catch { throw new BoundaryError('ERROR_LOG_OPEN_FAILED', '无法打开错误日志目录。请检查目录是否可访问后重试。') }
      return location
    },
    flush: () => pending,
  }
}
