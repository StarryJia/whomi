import { randomUUID } from 'node:crypto'
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
  'INVALID_RESPONSE', 'MAIN_PROCESS_ERROR', 'MODEL_AUTH_FAILED', 'MODEL_CONNECTION_FAILED', 'MODEL_CONTEXT_LIMIT',
  'MODEL_DISABLED', 'MODEL_INPUT_TOO_SMALL', 'MODEL_NOT_FOUND', 'MODEL_OUTPUT_LIMIT', 'MODEL_RATE_LIMIT',
  'MODEL_REQUEST_FAILED', 'MODEL_SYNC_FAILED', 'MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'PRELOAD_ERROR', 'RENDERER_ERROR', 'RENDERER_LOAD_FAILED',
  'RENDERER_PROCESS_GONE', 'SERVICE_UNAVAILABLE', 'STARTUP_FAILED', 'STORAGE_MIGRATION_FAILED',
  'STORAGE_OPEN_FAILED', 'STORAGE_UNAVAILABLE', 'STORAGE_UNWRITABLE',
])

function pathKey(path: string) { return process.platform === 'win32' ? path.toLowerCase() : path }

export async function localLogDirectory(directory: string, create = false) {
  const parent = dirname(directory)
  if (pathKey(await realpath(parent)) !== pathKey(parent)) throw new Error('Invalid log directory')
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (!(await lstat(directory)).isDirectory() || pathKey(await realpath(directory)) !== pathKey(directory)) {
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

export function createAppErrorLogs(userDataPath: string, version: string, openPath: (path: string) => Promise<string>) {
  const profile = resolve(userDataPath)
  const legacyImport = join(profile, 'import-errors')
  const fallbackDirectory = join(profile, 'logs')
  let preferred = fallbackDirectory
  let activeDirectory: string | undefined
  let pending = Promise.resolve()

  function schedule<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action)
    pending = next.then(() => {}, () => {})
    return next
  }

  const directories = () => [...new Set([activeDirectory ?? preferred, preferred, fallbackDirectory])]

  function withWritableRoot<T>(action: (directory: string) => Promise<T>) {
    return schedule(async () => {
      for (const path of directories()) {
        try {
          const root = await localLogDirectory(path, true)
          const value = await action(root)
          activeDirectory = root
          return value
        } catch { /* 目录暂时不可用时，继续使用同一用户的其他日志目录。 */ }
      }
      throw new BoundaryError('ERROR_LOG_UNWRITABLE', '无法写入错误日志。请检查磁盘空间和数据目录权限后重试。')
    })
  }

  function archivePath(archive: ErrorLogArchive) { return archive === 'legacy-import' ? legacyImport : fallbackDirectory }

  return {
    async setStorageDirectory(directory: string) {
      await schedule(async () => {
        preferred = join(resolve(directory), 'logs')
        activeDirectory = undefined
      })
    },
    withWritableRoot,
    importDirectories: () => [...directories().map(path => join(path, 'import-errors')), legacyImport],
    async record({ area, phase, error, taskId, analyzedMessages, budget }: AppError) {
      const code = error instanceof BoundaryError && knownCodes.has(error.code) ? error.code : 'OPERATION_FAILED'
      const id = localId(taskId) ? taskId : undefined
      const now = new Date()
      const filename = [now.getTime(), area, id, randomUUID()].filter(Boolean).join('-') + '.json'
      const record = { recordedAt: now.toISOString(), version, area, phase, code, taskId: id, analyzedMessages, budget }
      await withWritableRoot(root => writeLocalLog(root, filename, record))
        .catch(() => { /* 日志目录故障不能取代原操作的结果。 */ })
    },
    async getArchives(): Promise<ErrorLogArchive[]> {
      await pending
      const available: ErrorLogArchive[] = []
      for (const archive of ['legacy-import', 'fallback'] as const) {
        const directory = archivePath(archive)
        if (directory === (activeDirectory ?? preferred)) continue
        try {
          if ((await readdir(await localLogDirectory(directory))).length) available.push(archive)
        } catch { /* 尚无归档目录。 */ }
      }
      return available
    },
    async open(target: ErrorLogTarget): Promise<ErrorLogLocation> {
      if (target !== 'current' && target !== 'legacy-import' && target !== 'fallback') throw new BoundaryError('INVALID_ARGUMENT')
      const location = target === 'current'
        ? await withWritableRoot(async path => {
          // 打开时也核实写入位置，确保空目录和备用目录的行为一致。
          const probe = join(path, `.${randomUUID()}.tmp`)
          await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
          await unlink(probe)
          return { path, fallback: path !== preferred }
        })
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
