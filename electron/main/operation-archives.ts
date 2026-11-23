import { lstatSync, readdirSync } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isOperationId } from '../../src/shared/operation-diagnostics'
import { localLogDirectory, logPathKey } from './app-error-logs'
import { filenameId } from './operation-text'

export type ArchiveFile = { path: string; size: number; at: number; binding?: string }
export const taskBinding = (area: string, id: string, createdAt: number) => [area, id, createdAt].join('/')
export async function checkedSize(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || logPathKey(await realpath(path)) !== logPathKey(path)) throw Error('Invalid log file')
  return info.size
}

const general = /^(\d{13})-(startup|main|renderer|data|model|conversation|insight)-(?:[1-9]\d{0,18}-)?([a-f\d-]{36})\.json$/
const imported = /^(\d{13})-([a-f\d-]{36})-(?:(\d{1,16})-)?(none|[1-9]\d{0,18})\.txt$/
export function legacyFile(root: string, name: string, isImport: boolean, size: number): ArchiveFile | undefined {
  const parts = (isImport ? imported : general).exec(name)
  if (!parts || !isOperationId(parts[isImport ? 2 : 3])) return
  const binding = isImport && parts[3] && parts[4] !== 'none' ? taskBinding('import', parts[4], Number(parts[3])) : undefined
  return { path: join(root, name), size, at: Number(parts[1]), binding }
}

export async function scanLegacy(directory: string) {
  const files = new Map<string, ArchiveFile>()
  for (const root of [directory, join(directory, 'import-errors'), join(directory, 'operations')]) {
    try { await localLogDirectory(root) } catch { continue }
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isFile()) continue
      const temp = /^\.(?:whomi-)(.+)\.([a-f\d-]{36})\.tmp$/.exec(item.name)
      const deleting = /^(.+)\.([a-f\d-]{36})\.deleting$/.exec(item.name)
      const original = temp || deleting
      const canonical = original && isOperationId(original[2]) ? original[1] : item.name
      const inOperations = root === join(directory, 'operations')
      const entry = inOperations
        ? deleting && filenameId(canonical) && { path: join(root, canonical), at: 0, size: 0 }
        : legacyFile(root, canonical, root !== directory, 0)
      if (!entry) continue
      try {
        if (original && canonical !== item.name) {
          const path = join(root, item.name)
          files.set(path, { ...entry, path, at: 0, binding: undefined, size: await checkedSize(path) })
          continue
        }
        entry.size = await checkedSize(entry.path)
        if (entry.size > 4096) continue
        const record = JSON.parse(await readFile(entry.path, 'utf8'))
        if (Date.parse(record.recordedAt) !== entry.at || typeof record.version !== 'string'
          || typeof record.phase !== 'string' || typeof record.code !== 'string') continue
        if (root === directory && !item.name.startsWith(String(entry.at) + '-' + record.area + '-')) continue
        files.set(entry.path, entry)
      } catch { /* 保留无法确认为 Whomi 日志的文件。 */ }
    }
  }
  return files
}

// 崩溃可能发生在异步日志索引加载完成之前。
export function crashUsage(directory: string) {
  let bytes = 0
  for (const root of [directory, join(directory, 'import-errors'), join(directory, 'operations')]) {
    let items
    try { items = readdirSync(root, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    for (const item of items) {
      if (item.isFile() && (filenameId(item.name) || legacyFile(root, item.name, root !== directory, 0)
        || item.name.startsWith('.whomi-') || item.name.endsWith('.deleting'))) bytes += lstatSync(join(root, item.name)).size
    }
  }
  return bytes
}
