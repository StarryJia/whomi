import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { BigIntStats } from 'node:fs'
import type { PrivateEntry } from './discovery'
import { checkSignal, fileLimit, ImportFailure } from './limits'
import { identity, openSource, pathKey, sameFile, within, type SourceAccess, type SourceFile } from './source-access'

export type SnapshotFile = { role: string; sha256: string; bytes: number }
export type Snapshot = { entry: string; allowedFiles: string[]; fingerprint: string; files: SnapshotFile[] }
export type StagingOwnership = { appDirectory: string; path: string; root: string; identity: string }
export async function cleanupRegisteredStaging(record: StagingOwnership): Promise<void> {
  const app = await fs.realpath(record.appDirectory), root = join(app, 'import-staging')
  if (pathKey(root) !== pathKey(record.root) || dirname(record.path) !== root || !within(root, record.path)) throw new ImportFailure('STAGING_PATH')
  if (pathKey(await fs.realpath(root)) !== pathKey(root)) throw new ImportFailure('STAGING_PATH')
  let info: BigIntStats
  try { info = await fs.stat(record.path, { bigint: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!info.isDirectory() || identity(info) !== record.identity || pathKey(await fs.realpath(record.path)) !== pathKey(record.path)) throw new ImportFailure('STAGING_PATH')
  await fs.rm(record.path, { recursive: true, force: true })
}
export function createSnapshotArea(appDataDirectory: string) {
  const owned = new Map<string, { root: string; identity: string }>()
  async function create() {
    await fs.mkdir(appDataDirectory, { recursive: true })
    const app = await fs.realpath(appDataDirectory), base = join(app, 'import-staging')
    await fs.mkdir(base, { recursive: true })
    if (pathKey(await fs.realpath(base)) !== pathKey(base)) throw new ImportFailure('STAGING_PATH')
    const path = join(base, randomUUID())
    await fs.mkdir(path)
    owned.set(path, { root: base, identity: identity(await fs.stat(path, { bigint: true })) })
    return path
  }
  async function cleanup(path: string) {
    const record = owned.get(path)
    if (!record || !within(record.root, path) || pathKey(path) === pathKey(record.root)) throw new ImportFailure('STAGING_PATH')
    let info: BigIntStats
    try { info = await fs.stat(path, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { owned.delete(path); return }; throw error }
    if (!info.isDirectory() || identity(info) !== record.identity || pathKey(await fs.realpath(path)) !== pathKey(path)
      || pathKey(await fs.realpath(record.root)) !== pathKey(record.root)) throw new ImportFailure('STAGING_PATH')
    await fs.rm(path, { recursive: true, force: true })
    owned.delete(path)
  }
  function ownership(path: string): StagingOwnership {
    const record = owned.get(path)
    if (!record) throw new ImportFailure('STAGING_PATH')
    return { appDirectory: dirname(record.root), path, ...record }
  }
  return { create, cleanup, ownership }
}

async function copyChecked(access: SourceAccess, file: SourceFile, target: string, maximum: number, signal: AbortSignal): Promise<SnapshotFile> {
  checkSignal(signal)
  if (file.info.size > BigInt(maximum)) throw new ImportFailure('FILE_LIMIT')
  const input = await openSource(access, file)
  let output: fs.FileHandle | undefined
  try {
    await fs.mkdir(dirname(target), { recursive: true })
    output = await fs.open(target, 'wx')
    const digest = createHash('sha256'), verify = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (true) {
      checkSignal(signal)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      if (offset > maximum || BigInt(offset) > file.info.size) throw new ImportFailure('SOURCE_CHANGED')
      digest.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset - bytesRead + written)
        if (!bytesWritten) throw new ImportFailure('DISK_SPACE')
        written += bytesWritten
      }
    }
    if (BigInt(offset) !== file.info.size || !sameFile(file.info, await input.stat({ bigint: true }))) throw new ImportFailure('SOURCE_CHANGED')
    // A second descriptor read detects changes even when the final length is unchanged.
    let position = 0
    while (true) {
      checkSignal(signal)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      if (position > maximum) throw new ImportFailure('SOURCE_CHANGED')
      verify.update(buffer.subarray(0, bytesRead))
    }
    const sha256 = digest.digest('hex')
    if (verify.digest('hex') !== sha256 || !sameFile(file.info, await input.stat({ bigint: true }))) throw new ImportFailure('SOURCE_CHANGED')
    const final = await openSource(access, file)
    await final.close()
    await output.sync()
    await output.close(); output = undefined
    await fs.chmod(target, 0o444)
    return { role: file.role, sha256, bytes: offset }
  } finally { await input.close(); await output?.close() }
}

export async function snapshotEntry(access: SourceAccess, source: PrivateEntry, directory: string, signal: AbortSignal): Promise<Snapshot> {
  checkSignal(signal)
  const maximum = fileLimit(source.parser.mode), bytes = source.files.reduce((total, file) => total + file.info.size, 0n)
  if (bytes > BigInt(maximum)) throw new ImportFailure('FILE_LIMIT')
  await fs.mkdir(directory)
  const files: SnapshotFile[] = [], allowedFiles: string[] = []
  for (const file of source.files) {
    const target = resolve(directory, file.role)
    if (!within(directory, target)) throw new ImportFailure('MANIFEST_PATH')
    if (allowedFiles.some(path => pathKey(path) === pathKey(target))) throw new ImportFailure('MANIFEST_PATH')
    files.push(await copyChecked(access, file, target, maximum, signal)); allowedFiles.push(target)
  }
  let entry = allowedFiles[0]
  if (source.generatedManifest) {
    entry = join(directory, 'google-chat-import.json')
    const content = JSON.stringify(source.generatedManifest), size = Buffer.byteLength(content)
    if (bytes + BigInt(size) > BigInt(maximum)) throw new ImportFailure('FILE_LIMIT')
    await fs.writeFile(entry, content, { flag: 'wx', mode: 0o444 })
    files.push({ role: 'google-chat-import.json', sha256: createHash('sha256').update(content).digest('hex'), bytes: size })
    allowedFiles.push(entry)
  }
  for (const file of source.files) { checkSignal(signal); const handle = await openSource(access, file); await handle.close() }
  const roles = files.map(({ role, sha256 }, index) => ({
    role: (source.generatedManifest ? index === files.length - 1 : index === 0) ? '@entry' : role, sha256,
  })).sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0)
  const fingerprint = files.length === 1 ? files[0].sha256 : createHash('sha256').update(JSON.stringify(roles)).digest('hex')
  return { entry, allowedFiles, fingerprint, files }
}
