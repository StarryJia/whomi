import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import type { ErrorLogArchive, ErrorLogLocation, ErrorLogTarget } from '../../src/shared/settings-contract'
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
  'INSIGHT_CONTEXT_LIMIT', 'INVALID_ANALYSIS', 'INVALID_EVIDENCE', 'INVALID_INSIGHT_REPORT', 'INVALID_INSIGHT_SNAPSHOT',
  'INVALID_INSIGHT_OUTPUT', 'INVALID_INSIGHT_CHECKPOINT', 'CHATGPT_LIMIT', 'CHATGPT_ACCESS', 'CHATGPT_RECONNECT',
  'CHATGPT_UNSUPPORTED', 'CHATGPT_INELIGIBLE', 'CHATGPT_UNAVAILABLE', 'CHATGPT_REQUEST', 'CHATGPT_INCOMPLETE',
  'CHATGPT_ACCOUNT_CHANGED', 'CHATGPT_BUSY', 'CHATGPT_CALLBACK', 'CHATGPT_CANCELLED', 'CHATGPT_DENIED', 'CHATGPT_IDENTITY',
  'CHATGPT_MODELS', 'CHATGPT_NETWORK', 'CHATGPT_PERMISSION', 'CHATGPT_REVOCATION', 'CHATGPT_TIMEOUT',
  'ACCOUNT_ACCESS', 'ACCOUNT_BUSY', 'ACCOUNT_CANCELLED', 'ACCOUNT_CHANGED', 'ACCOUNT_CLIENT_REQUIRED', 'ACCOUNT_INCOMPLETE',
  'ACCOUNT_LOGIN', 'ACCOUNT_NETWORK', 'ACCOUNT_REQUEST', 'ACCOUNT_REVOCATION', 'ACCOUNT_STORAGE', 'ACCOUNT_TIMEOUT',
  'CODEX_QUOTA_NETWORK', 'CODEX_QUOTA_RESPONSE', 'SUMMARY_TOO_LARGE', 'SESSION_SAVE_FAILED', 'INVALID_CHECKPOINT',
  'INVALID_RESPONSE', 'MAIN_PROCESS_ERROR', 'MODEL_AUTH_FAILED', 'MODEL_CONNECTION_FAILED', 'MODEL_CONTEXT_LIMIT',
  'MODEL_DISABLED', 'MODEL_INPUT_TOO_SMALL', 'MODEL_NOT_FOUND', 'MODEL_OUTPUT_LIMIT', 'MODEL_RATE_LIMIT',
  'MODEL_REQUEST_FAILED', 'MODEL_SYNC_FAILED', 'MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'PRELOAD_ERROR', 'RENDERER_ERROR', 'RENDERER_LOAD_FAILED',
  'RENDERER_PROCESS_GONE', 'SERVICE_UNAVAILABLE', 'STARTUP_FAILED', 'STORAGE_MIGRATION_FAILED',
  'STORAGE_OPEN_FAILED', 'STORAGE_UNAVAILABLE', 'STORAGE_UNWRITABLE',
])

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
  const temporary = join(root, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(root, filename))
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export function createAppErrorLogs(userDataPath: string, version: string, openPath: (path: string) => Promise<string>, onWriteFailure?: () => void) {
  const profile = resolve(userDataPath)
  const legacyImport = join(profile, 'import-errors')
  const fallbackDirectory = join(profile, 'logs')
  let preferred = fallbackDirectory
  let activeDirectory: string | undefined
  let retainedDirectories: string[] = []
  let missedRecords = 0
  let pending = Promise.resolve()

  function schedule<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action)
    pending = next.then(() => {}, () => {})
    return next
  }

  const directories = () => {
    const candidates = [activeDirectory ?? preferred, preferred, fallbackDirectory]
    return candidates.filter((path, index) => candidates.findIndex(other => logPathKey(other) === logPathKey(path)) === index)
  }

  function withWritableRoot<T>(action: (directory: string) => Promise<T>, recording = true) {
    return schedule(async () => {
      for (const path of directories()) {
        try {
          const root = await localLogDirectory(path, true)
          // 导入日志和应用日志共用根目录，子目录的权限可能与根目录不同。
          const probe = join(root, `.${randomUUID()}.tmp`)
          await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
          await unlink(probe)
          const value = await action(root)
          activeDirectory = root
          return value
        } catch { /* 目录暂时不可用时，继续使用同一用户的其他日志目录。 */ }
      }
      if (recording) {
        missedRecords += 1
        if (missedRecords === 1) onWriteFailure?.()
      }
      throw new BoundaryError('ERROR_LOG_UNWRITABLE', '无法写入错误日志。请检查磁盘空间和数据目录权限后重试。')
    })
  }

  function archivePath(archive: ErrorLogArchive) {
    if (archive === 'legacy-import') return legacyImport
    if (archive === 'data') return preferred
    if (archive === 'fallback') return fallbackDirectory
    const retained = retainedDirectories.find(path => archive === `retained:${path}`)
    if (!retained) throw new BoundaryError('INVALID_ARGUMENT')
    return retained
  }
  function selectStorageDirectory(directory: string, retained: string[] = []) {
    retainedDirectories = retained
    preferred = join(resolve(directory), 'logs')
    activeDirectory = undefined
  }

  return {
    async setStorageDirectory(directory: string, retained: string[] = []) {
      await schedule(async () => selectStorageDirectory(directory, retained))
    },
    withStorageRelocation<T extends { path: string; retainedErrorLogDirectories?: string[] }>(relocate: () => Promise<T>) {
      // 迁移校验期间，错误记录排队，切换成功后再写入新目录。
      return schedule(async () => {
        const result = await relocate()
        selectStorageDirectory(result.path, result.retainedErrorLogDirectories)
        return result
      })
    },
    withWritableRoot,
    recordMainException(origin: NodeJS.UncaughtExceptionOrigin) {
      // 进程可能在回调返回后立即退出。
      const now = new Date()
      const phase = origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException'
      const record = { recordedAt: now.toISOString(), version, area: 'main', phase, code: 'MAIN_PROCESS_ERROR' }
      for (const root of directories()) {
        try {
          if (logPathKey(realpathSync(dirname(root))) !== logPathKey(dirname(root))) continue
          try { mkdirSync(root, { mode: 0o700 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') continue }
          if (!lstatSync(root).isDirectory() || logPathKey(realpathSync(root)) !== logPathKey(root)) continue
          writeFileSync(join(root, `${now.getTime()}-main-${randomUUID()}.json`), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
          return
        } catch { /* 退出前仍可尝试备用目录。 */ }
      }
    },
    importDirectories: () => [...[...directories(), ...retainedDirectories].map(path => join(path, 'import-errors')), legacyImport],
    async record({ area, phase, error, taskId, analyzedMessages, budget }: AppError) {
      const code = error instanceof BoundaryError && knownCodes.has(error.code) ? error.code : 'OPERATION_FAILED'
      const id = localId(taskId) ? taskId : undefined
      const now = new Date()
      const filename = [now.getTime(), area, id, randomUUID()].filter(Boolean).join('-') + '.json'
      const record = { recordedAt: now.toISOString(), version, area, phase, code, taskId: id, analyzedMessages, budget }
      return withWritableRoot(async root => {
        await writeLocalLog(root, filename, record)
        return root
      }).catch(() => undefined)
    },
    async getArchives(): Promise<ErrorLogArchive[]> {
      await pending
      const available: ErrorLogArchive[] = []
      const seen = new Set([logPathKey(activeDirectory ?? preferred)])
      const archives: ErrorLogArchive[] = ['legacy-import', 'fallback', 'data', ...retainedDirectories.map(path => `retained:${path}` as const)]
      for (const archive of archives) {
        const directory = archivePath(archive)
        const key = logPathKey(directory)
        if (seen.has(key)) continue
        seen.add(key)
        try {
          if ((await readdir(await localLogDirectory(directory))).length) available.push(archive)
        } catch { /* 尚无归档目录。 */ }
      }
      return available
    },
    async open(target: ErrorLogTarget): Promise<ErrorLogLocation> {
      const location = target === 'current'
        ? await withWritableRoot(async path => ({ path, fallback: logPathKey(path) !== logPathKey(preferred), ...(missedRecords && { missedRecords }) }), false)
        : { path: archivePath(target), fallback: false }
      try {
        await localLogDirectory(location.path)
        if (await openPath(location.path)) throw new Error('Native open failed')
      } catch { throw new BoundaryError('ERROR_LOG_OPEN_FAILED', '无法打开错误日志目录。请检查目录是否可访问后重试。') }
      return location
    },
    flush: () => pending,
  }
}
