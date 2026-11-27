import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import { insightTraceDirectory, insightTracePaths, pendingTracePrefix, temporaryTracePrefix } from './insight-trace'

const pendingPrefix = '.deleting-insight-'
const cleanupError = () => new BoundaryError('INSIGHT_CLEANUP_FAILED', '请检查数据目录后重试删除。')

export function createInsightSessionCleanup(directory: string, taskExists: (id: string) => Promise<boolean>) {
  const sessionRoot = join(directory, 'ai-runtime', 'sessions')
  function paths(id: string) {
    if (!localId(id)) throw cleanupError()
    const key = createHash('sha256').update('insight:' + id).digest('hex')
    const trace = insightTracePaths(directory, id)
    return [
      { original: join(sessionRoot, key), pending: join(sessionRoot, pendingPrefix + id), directory: true },
      { original: trace.original, pending: trace.pending, directory: false },
    ]
  }

  async function exists(path: string, directory: boolean) {
    try {
      const entry = await lstat(path)
      if (!(directory ? entry.isDirectory() : entry.isFile()) || relative(path, await realpath(path)) !== '') throw cleanupError()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  // 数据库事务的结果决定崩溃后应恢复断点还是完成清理。
  async function reconcile(id: string, committed = false) {
    let restore: boolean | undefined
    for (const entry of paths(id)) {
      if (!await exists(entry.pending, entry.directory)) continue
      restore ??= !committed && await taskExists(id)
      if (restore) {
        if (await exists(entry.original, entry.directory)) throw cleanupError()
        await rename(entry.pending, entry.original)
      } else {
        await rm(entry.pending, { recursive: entry.directory, maxRetries: 2, retryDelay: 100 })
      }
    }
    // 未完成原子替换的临时文件从来不是有效断点。
    const { temporary } = insightTracePaths(directory, id)
    if (await exists(temporary, false)) await rm(temporary)
  }

  async function settle(ids: readonly string[], committed = false) {
    const results = await Promise.allSettled(ids.map(id => reconcile(id, committed)))
    if (results.some(result => result.status === 'rejected')) throw cleanupError()
  }

  return {
    async recover() {
      const ids = new Set<string>()
      if (await exists(sessionRoot, true)) {
        for (const name of await readdir(sessionRoot)) {
          if (name.startsWith(pendingPrefix)) ids.add(name.slice(pendingPrefix.length))
        }
      }
      const traceRoot = insightTraceDirectory(directory)
      if (await exists(traceRoot, true)) {
        for (const name of await readdir(traceRoot)) {
          for (const prefix of [pendingTracePrefix, temporaryTracePrefix]) {
            if (name.startsWith(prefix) && name.endsWith('.json')) ids.add(name.slice(prefix.length, -5))
          }
        }
      }
      await settle([...ids].filter(id => localId(id)))
    },
    async remove(ids: readonly string[], removeRecords: () => Promise<void>) {
      const staged: string[] = []
      try {
        for (const id of new Set(ids)) {
          await reconcile(id)
          staged.push(id)
          for (const entry of paths(id)) {
            if (await exists(entry.original, entry.directory)) await rename(entry.original, entry.pending)
          }
        }
      } catch {
        await settle(staged)
        throw cleanupError()
      }
      try { await removeRecords() }
      catch (error) { await settle(staged); throw error }
      try { await settle(staged, true) }
      catch { throw new BoundaryError('INSIGHT_CLEANUP_PENDING', '记录已删除。请关闭占用数据目录的程序并重启 Whomi，以清理剩余文件。') }
    },
  }
}
