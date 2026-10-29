import * as fs from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { ImportFailure } from './limits'

export type SourceAccess = {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<BigIntStats>
  readdir(path: string): Promise<string[]>
  open(path: string, flags: string): Promise<FileHandle>
}
export const sourceAccess: SourceAccess = { realpath: fs.realpath, stat: path => fs.stat(path, { bigint: true }), readdir: fs.readdir, open: fs.open }
export const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
export function within(root: string, target: string) {
  const rel = relative(pathKey(root), pathKey(target))
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}
export const identity = (info: BigIntStats) => `${info.dev}:${info.ino}`
export function sameFile(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && identity(a) === identity(b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
export type SourceFile = { path: string; root: string; actual: string; info: BigIntStats; role: string }
export async function inspectFile(access: SourceAccess, root: string, path: string, role: string): Promise<SourceFile> {
  if (!within(root, path)) throw new ImportFailure('MANIFEST_PATH')
  const actual = await access.realpath(path)
  if (!within(root, actual)) throw new ImportFailure('PATH_ESCAPE')
  const info = await access.stat(actual)
  if (!info.isFile()) throw new ImportFailure('SOURCE_UNREADABLE')
  return { path, root, actual, info, role }
}
export async function openSource(access: SourceAccess, file: SourceFile) {
  const actual = await access.realpath(file.path)
  if (!within(file.root, actual)) throw new ImportFailure('PATH_ESCAPE')
  if (pathKey(actual) !== pathKey(file.actual)) throw new ImportFailure('SOURCE_CHANGED')
  const handle = await access.open(actual, 'r')
  try {
    if (!sameFile(file.info, await handle.stat({ bigint: true }))) throw new ImportFailure('SOURCE_CHANGED')
    // Recheck the path after opening so a swapped parent cannot authorize another file.
    if (pathKey(await access.realpath(file.path)) !== pathKey(actual)) throw new ImportFailure('SOURCE_CHANGED')
    return handle
  } catch (error) { await handle.close(); throw error }
}
export async function readSource(access: SourceAccess, file: SourceFile, maxBytes: number, prefix = false) {
  if (!prefix && file.info.size > BigInt(maxBytes)) throw new ImportFailure('FILE_LIMIT')
  const handle = await openSource(access, file)
  try {
    const length = Math.min(Number(file.info.size), maxBytes), buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
      if (!bytesRead) throw new ImportFailure('SOURCE_CHANGED')
      offset += bytesRead
    }
    if (!sameFile(file.info, await handle.stat({ bigint: true }))) throw new ImportFailure('SOURCE_CHANGED')
    return buffer
  } finally { await handle.close() }
}
