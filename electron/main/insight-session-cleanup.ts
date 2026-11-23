import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'

const pendingPrefix = '.deleting-insight-'
const cleanupError = () => new BoundaryError('INSIGHT_CLEANUP_FAILED', '请检查数据目录后重试删除。')

export function createInsightSessionCleanup(directory: string, taskExists: (id: string) => Promise<boolean>) {
  function paths(id: string) {
    if (!localId(id)) throw cleanupError()
    const root = join(directory, 'ai-runtime', 'sessions')
    const key = createHash('sha256').update('insight:' + id).digest('hex')
    return { original: join(root, key), pending: join(root, pendingPrefix + id) }
  }

  async function isDirectory(path: string) {
    try {
      const entry = await lstat(path)
      if (!entry.isDirectory() || entry.isSymbolicLink() || relative(path, await realpath(path)) !== '') throw cleanupError()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  // 数据库事务的结果决定崩溃后应恢复断点还是完成清理。
  async function reconcile(id: string, committed = false) {
    const { original, pending } = paths(id)
    if (!await isDirectory(pending)) return
    if (!committed && await taskExists(id)) {
      if (await isDirectory(original)) throw cleanupError()
      await rename(pending, original)
    } else {
      await rm(pending, { recursive: true, maxRetries: 2, retryDelay: 100 })
    }
  }

  async function settle(ids: readonly string[], committed = false) {
    const results = await Promise.allSettled(ids.map(id => reconcile(id, committed)))
    if (results.some(result => result.status === 'rejected')) throw cleanupError()
  }

  return {
    async recover() {
      const root = join(directory, 'ai-runtime', 'sessions')
      if (!await isDirectory(root)) return
      const ids = (await readdir(root)).filter(name => name.startsWith(pendingPrefix))
        .map(name => name.slice(pendingPrefix.length)).filter(id => localId(id))
      await settle(ids)
    },
    async remove(ids: readonly string[], removeRecords: () => Promise<void>) {
      const staged: string[] = []
      try {
        for (const id of new Set(ids)) {
          const { original, pending } = paths(id)
          await reconcile(id)
          if (!await isDirectory(original)) continue
          await rename(original, pending)
          staged.push(id)
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
