import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { StorageChoice, StorageLocation } from '../../src/shared/settings-contract'

export type StorageLocationOptions = {
  userDataPath: string
  blockedDirectories?: readonly string[]
  stopServices(): Promise<void>
  resumeServices(directory: string): Promise<void>
  now?: () => number
}

const pointerName = 'storage-location.json'
const managedNames = ['whomi.db', 'whomi.db-wal', 'whomi.db-shm', 'whomi.db-journal', 'ai-runtime', 'import-staging']
type Entry = { path: string; info: BigIntStats }
type Grant = { owner: number; path: string; identity: string; expires: number }
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}`
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function within(root: string, path: string) {
  const part = relative(pathKey(root), pathKey(path))
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
function invalidPath(): never { throw new BoundaryError('INVALID_STORAGE_PATH', '请选择当前保存目录之外的空文件夹，不要使用链接目录。') }

async function checkedPath(path: string, allowMissing = false): Promise<BigIntStats | undefined> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || (process.platform === 'win32' && /^[\\/]{2}/.test(path))) invalidPath()
  const absolute = resolve(path), root = parse(absolute).root
  let cursor = root, info: BigIntStats | undefined
  for (const part of ['', ...absolute.slice(root.length).split(sep).filter(Boolean)]) {
    cursor = join(cursor, part)
    try { info = await fs.lstat(cursor, { bigint: true }) }
    catch (error) { if (allowMissing && missing(error)) return undefined; throw error }
    if (info.isSymbolicLink() || (cursor !== absolute && !info.isDirectory())) invalidPath()
  }
  if (pathKey(await fs.realpath(absolute)) !== pathKey(absolute)) invalidPath()
  return info
}

async function checkedDirectory(path: string) {
  const info = await checkedPath(path)
  if (!info?.isDirectory()) invalidPath()
  return info
}

export async function resolveStorageLocation(userDataPath: string): Promise<string> {
  try {
    await checkedPath(userDataPath, true)
    await fs.mkdir(userDataPath, { recursive: true })
    await checkedDirectory(userDataPath)
    const pointer = join(userDataPath, pointerName)
    const info = await checkedPath(pointer, true)
    if (!info) return resolve(userDataPath)
    if (!info.isFile() || info.size > 16_384n) throw new Error('Invalid storage pointer')
    const data = JSON.parse(await fs.readFile(pointer, 'utf8')) as { version?: unknown; path?: unknown; hasDatabase?: unknown }
    if (data.version !== 1 || typeof data.path !== 'string' || typeof data.hasDatabase !== 'boolean') throw new Error('Invalid storage pointer')
    await checkedDirectory(data.path)
    if (data.hasDatabase) {
      const databasePath = join(data.path, 'whomi.db'), databaseInfo = await checkedPath(databasePath)
      if (!databaseInfo?.isFile() || databaseInfo.nlink !== 1n || databaseInfo.size < 100n) throw new Error('Invalid database')
      const handle = await fs.open(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!unchanged(databaseInfo, await handle.stat({ bigint: true }))) throw new Error('Database changed')
        const header = Buffer.alloc(16)
        await handle.read(header, 0, header.length, 0)
        if (header.toString('ascii') !== 'SQLite format 3\0') throw new Error('Invalid database')
      } finally { await handle.close() }
    }
    return resolve(data.path)
  } catch { throw new BoundaryError('STORAGE_UNAVAILABLE', '无法打开保存目录，请恢复目录访问权限后重新打开应用。') }
}

async function manifest(root: string): Promise<Entry[]> {
  await checkedDirectory(root)
  const entries: Entry[] = []
  async function walk(path: string) {
    const info = await checkedPath(path)
    if (!info || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1n)) invalidPath()
    entries.push({ path: relative(root, path), info })
    if (info.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name))
  }
  for (const name of managedNames) {
    const path = join(root, name)
    if (await checkedPath(path, true)) await walk(path)
  }
  return entries
}

function unchanged(expected: BigIntStats, actual: BigIntStats) {
  return identity(expected) === identity(actual) && expected.size === actual.size && expected.mtimeNs === actual.mtimeNs && expected.ctimeNs === actual.ctimeNs
}

async function digest(handle: fs.FileHandle) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024)
  let offset = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    if (!bytesRead) break
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
  }
  return hash.digest('hex')
}

async function copyEntry(source: string, target: string, entry: Entry, created: Entry[]) {
  const from = join(source, entry.path), to = join(target, entry.path)
  const current = await checkedPath(from)
  if (!current || !unchanged(entry.info, current)) throw new Error('Source changed')
  await checkedDirectory(dirname(to))
  if (entry.info.isDirectory()) {
    await fs.mkdir(to)
    created.push({ path: to, info: await fs.lstat(to, { bigint: true }) })
    return
  }
  const input = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output: fs.FileHandle | undefined
  try {
    if (!unchanged(entry.info, await input.stat({ bigint: true }))) throw new Error('Source changed')
    output = await fs.open(to, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created.push({ path: to, info: await output.stat({ bigint: true }) })
    const buffer = Buffer.alloc(256 * 1024), hash = createHash('sha256')
    let offset = 0
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written)
        if (!bytesWritten) throw new Error('Copy failed')
        written += bytesWritten
      }
      offset += bytesRead
      if (BigInt(offset) > entry.info.size) throw new Error('Source changed')
    }
    await output.sync()
    const expected = hash.digest('hex')
    if (BigInt(offset) !== entry.info.size || expected !== await digest(input) || expected !== await digest(output)
      || !unchanged(entry.info, await input.stat({ bigint: true }))) throw new Error('Copy verification failed')
    const final = await checkedPath(from)
    if (!final || !unchanged(entry.info, final)) throw new Error('Source changed')
  } finally { await output?.close(); await input.close() }
}

async function cleanupCreated(target: string, targetIdentity: string, created: Entry[]) {
  for (const entry of [...created].reverse()) {
    try {
      if (identity(await checkedDirectory(target)) !== targetIdentity || !within(target, entry.path)) return
      const current = await checkedPath(entry.path)
      if (!current || identity(current) !== identity(entry.info)) continue
      // 删除仅限本次创建的条目；额外出现的文件和替换后的目录必须保留。
      if (current.isDirectory()) await fs.rmdir(entry.path)
      else await fs.unlink(entry.path)
    } catch { /* 保留无法确认所有权或仍含文件的目录。 */ }
  }
}

async function verifyCreated(target: string, targetIdentity: string, created: Entry[], databaseUpdated = false) {
  if (identity(await checkedDirectory(target)) !== targetIdentity) invalidPath()
  for (const entry of created) {
    const info = await checkedPath(entry.path, true)
    // SQLite 关闭目标数据库时会合并日志并移除这些临时文件。
    if (!info && databaseUpdated && ['whomi.db-wal', 'whomi.db-shm', 'whomi.db-journal'].includes(relative(target, entry.path))) continue
    if (!info || identity(info) !== identity(entry.info) || (info.isFile() && info.nlink !== 1n)) invalidPath()
  }
}

async function rebaseDatabase(source: string, target: string) {
  const path = join(target, 'whomi.db')
  if (!await checkedPath(path, true)) return
  const db = new Database(path, { fileMustExist: true })
  try {
    db.defaultSafeIntegers(true)
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Invalid database')
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name))
    const updates: { old: string; path: string; root: string; identity: string }[] = []
    if (tables.has('import_staging_areas')) {
      for (const row of db.prepare('SELECT path FROM import_staging_areas').all() as { path: string }[]) {
        if (pathKey(dirname(row.path)) !== pathKey(join(source, 'import-staging'))) throw new Error('Invalid staging directory')
        const next = join(target, relative(source, row.path)), info = await checkedPath(next, true)
        updates.push({ old: row.path, path: next, root: join(target, 'import-staging'), identity: info ? identity(info) : '' })
      }
    }
    db.transaction(() => {
      for (const table of ['ai_turns', 'ai_analysis_tasks']) {
        if (!tables.has(table)) continue
        const rows = db.prepare(`SELECT id, checkpoint FROM ${table} WHERE checkpoint IS NOT NULL`).all() as { id: bigint; checkpoint: string }[]
        for (const row of rows) {
          const checkpoint = rebaseCheckpoint(row.checkpoint, source, target)
          if (checkpoint !== row.checkpoint) db.prepare(`UPDATE ${table} SET checkpoint=? WHERE id=?`).run(checkpoint, row.id)
        }
      }
      for (const row of updates) {
        if (!row.identity) db.prepare('DELETE FROM import_staging_areas WHERE path=?').run(row.old)
        else db.prepare('UPDATE import_staging_areas SET path=?, app_directory=?, root=?, identity=? WHERE path=?').run(row.path, target, row.root, row.identity, row.old)
      }
    }).immediate()
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Invalid database')
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally { db.close() }
}

function rebaseCheckpoint(value: string, source: string, target: string, depth = 0): string {
  if (depth > 4) return value
  let checkpoint: { sessionFile?: unknown; checkpoint?: unknown }
  try { checkpoint = JSON.parse(value) as typeof checkpoint } catch { return value }
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return value
  let changed = false
  if (typeof checkpoint.sessionFile === 'string' && isAbsolute(checkpoint.sessionFile) && within(join(source, 'ai-runtime', 'sessions'), checkpoint.sessionFile)) {
    checkpoint.sessionFile = join(target, relative(source, checkpoint.sessionFile))
    changed = true
  }
  if (typeof checkpoint.checkpoint === 'string') {
    const nested = rebaseCheckpoint(checkpoint.checkpoint, source, target, depth + 1)
    changed ||= nested !== checkpoint.checkpoint
    checkpoint.checkpoint = nested
  }
  return changed ? JSON.stringify(checkpoint) : value
}

async function publishPointer(userDataPath: string, target: string) {
  await checkedDirectory(userDataPath)
  const pointer = join(userDataPath, pointerName), temporary = join(userDataPath, `.storage-location-${randomUUID()}.tmp`)
  try {
    const hasDatabase = Boolean((await checkedPath(join(target, 'whomi.db'), true))?.isFile())
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, path: target, hasDatabase })}\n`)
      await handle.sync()
    } finally { await handle.close() }
    await checkedDirectory(userDataPath)
    const current = await checkedPath(pointer, true)
    if (current && (!current.isFile() || current.nlink !== 1n)) throw new Error('Invalid storage pointer')
    await fs.rename(temporary, pointer)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

export function createStorageLocationService(options: StorageLocationOptions) {
  const grants = new Map<string, Grant>(), now = options.now ?? Date.now
  let location: string | undefined, busy = false, restartRequired = false
  const current = async () => location ??= await resolveStorageLocation(options.userDataPath)
  const snapshot = async (): Promise<StorageLocation> => ({ path: await current(), defaultPath: resolve(options.userDataPath), restartRequired })
  function requireAvailable() {
    if (restartRequired) throw new BoundaryError('STORAGE_RESTART_REQUIRED', '请重启应用后继续。')
    if (busy) throw new BoundaryError('STORAGE_BUSY', '请等待目录迁移完成。')
  }
  async function destination(path: string, source: string, expectedIdentity?: string) {
    if (options.blockedDirectories?.some(directory => within(directory, path) || within(path, directory))) {
      throw new BoundaryError('INVALID_STORAGE_PATH', '请选择安装目录之外的空文件夹。')
    }
    try {
      const info = await checkedDirectory(path)
      if (within(source, path) || within(path, source) || (expectedIdentity && identity(info) !== expectedIdentity) || (await fs.readdir(path)).length) invalidPath()
      return info
    } catch { return invalidPath() }
  }
  function revokeOwner(owner: number) { for (const [token, grant] of grants) if (grant.owner === owner) grants.delete(token) }
  return {
    getStorage: snapshot,
    async issueChoice(owner: number, path: string): Promise<StorageChoice> {
      requireAvailable()
      const source = await current(), info = await destination(path, source)
      requireAvailable()
      revokeOwner(owner)
      const token = randomUUID()
      grants.set(token, { owner, path: resolve(path), identity: identity(info), expires: now() + 30 * 60 * 1000 })
      return { token, path: resolve(path) }
    },
    revokeOwner,
    async relocateStorage(owner: number, token: string): Promise<StorageLocation> {
      requireAvailable()
      const grant = grants.get(token)
      if (!grant || grant.owner !== owner || grant.expires <= now()) throw new BoundaryError('INVALID_STORAGE_CHOICE', '请重新选择保存目录。')
      busy = true
      let source: string | undefined, stopAttempted = false
      const created: Entry[] = []
      try {
        source = await current()
        await destination(grant.path, source, grant.identity)
        stopAttempted = true
        await options.stopServices()
        await destination(grant.path, source, grant.identity)
        const entries = await manifest(source)
        for (const entry of entries) await copyEntry(source, grant.path, entry, created)
        const remaining = await manifest(source)
        if (entries.length !== remaining.length || entries.some((entry, index) => entry.path !== remaining[index].path || !unchanged(entry.info, remaining[index].info))) throw new Error('Source changed')
        await verifyCreated(grant.path, grant.identity, created)
        await rebaseDatabase(source, grant.path)
        await verifyCreated(grant.path, grant.identity, created, true)
        const copiedNames = new Set(entries.map(entry => entry.path.split(sep)[0]))
        if ((await fs.readdir(grant.path)).some(name => !copiedNames.has(name))) invalidPath()
        await publishPointer(options.userDataPath, grant.path)
        location = grant.path
        restartRequired = true
        grants.clear()
        return await snapshot()
      } catch (error) {
        await cleanupCreated(grant.path, grant.identity, created)
        if (stopAttempted && source) {
          try { await options.resumeServices(source) }
          catch { restartRequired = true; grants.clear(); throw new BoundaryError('STORAGE_RESTORE_FAILED', '保存目录未更改，请重新打开应用。') }
        }
        if (error instanceof BoundaryError) throw error
        throw new BoundaryError('STORAGE_MIGRATION_FAILED', '迁移未完成，请检查目标目录权限和可用空间后重试。')
      } finally { busy = false }
    },
  }
}
