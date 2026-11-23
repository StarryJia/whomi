import { randomUUID } from 'node:crypto'
import { appendFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import { isOperationId, operationActionLabels, operationAreaLabels, operationOutcomeLabels, operationRetentionMs,
  type OperationArea, type OperationSummary } from '../../src/shared/operation-diagnostics'
import { localLogDirectory, writeLocalLog } from './app-error-logs'
import { checkedSize, crashUsage, legacyFile, scanLegacy, taskBinding, type ArchiveFile } from './operation-archives'
import { safeFields, stageLabels } from './operation-fields'
import { encodeRow, filenameId, logFilename, readLog, summaryHeader, updateHeader, validVersion, type Outcome, type Row } from './operation-text'

const day = 86_400_000
const mib = 1_048_576
type Entry = { summary: OperationSummary; size: number; version: string; retry: boolean; code?: string
  attachmentUntil?: number
  binding?: string; header: Row; missing: boolean; waitingForRestart: boolean; name: string }
type Options = { now?: () => number; maxBytes?: number; targetBytes?: number; onWriteFailure?: (message: string) => void }
type Waiting = { first: Row; last: Row; count: number }
type Candidate = { id?: string; files: ArchiveFile[]; at: number; priority: number }

function applyRow(entry: Entry, row: Row) {
  const summary = entry.summary
  summary.lastAt = row.at
  if (row.fields?.code) entry.code = String(row.fields.code)
  if (row.kind === 'retry') entry.retry = true
  if (row.kind === 'bind' && localId(row.taskId) && Number.isSafeInteger(row.createdAt)) {
    entry.binding = taskBinding(summary.area, row.taskId!, row.createdAt!)
  }
  if (row.kind === 'end' && row.outcome && Object.hasOwn(operationOutcomeLabels, row.outcome)) {
    summary.outcome = row.outcome
    summary.endedAt = row.at
  }
  if (row.kind === 'event' && row.stage === 'waitingForRestart' && summary.area === 'storage' && summary.action === 'migrate') entry.waitingForRestart = true
  if (row.kind === 'resume') { summary.outcome = 'running'; summary.endedAt = null; entry.waitingForRestart = false }
  if (row.kind === 'gap' || row.incomplete) summary.complete = false
}

function newEntry(header: Row): Entry {
  const summary: OperationSummary = { id: header.id!, area: header.area!, action: header.action!, startedAt: header.at,
    endedAt: null, lastAt: header.at, outcome: 'running', complete: !header.incomplete }
  return { summary, name: logFilename(summary), version: header.version!, header,
    size: 0, retry: false, missing: false, waitingForRestart: false }
}

const missingOperation = () => new BoundaryError('DIAGNOSTIC_NOT_FOUND', '找不到这次操作的日志。')
const failureMessage = '诊断日志未完整保存。可直接提交问题并说明操作步骤。'

export function createOperationDiagnostics(installDirectory: string, version: string, options: Options = {}) {
  const now = options.now ?? Date.now
  const maximum = options.maxBytes ?? 128 * mib, target = options.targetBytes ?? 112 * mib
  const root = join(resolve(installDirectory), 'logs'), directory = join(root, 'operations')
  const operationPath = (entry: Entry) => join(directory, entry.name)
  const entries = new Map<string, Entry>()
  const pins = new Map<string, number>()
  const progress = new Map<string, { stage: string; at: number; fields: string; waiting?: Waiting }>()
  let legacy = new Map<string, ArchiveFile>()
  let total = 0, warned = false
  let writingBytes = 0
  async function allocated<T>(bytes: number, write: () => Promise<T>) {
    writingBytes += bytes
    try { return await write() } finally { writingBytes -= bytes }
  }
  function warn(entry?: Entry) {
    if (entry) { entry.missing = true; entry.summary.complete = false }
    if (!warned) { warned = true; options.onWriteFailure?.(failureMessage) }
  }

  async function init() {
    await localLogDirectory(root, true)
    await localLogDirectory(directory, true)
    legacy = await scanLegacy(root)
    total = [...legacy.values()].reduce((size, file) => size + file.size, 0)
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const id = filenameId(file.name)
      if (!file.isFile() || !isOperationId(id)) continue
      let entry: Entry | undefined
      let size: number
      try {
        const path = join(directory, file.name)
        size = await checkedSize(path)
        await readLog(path, id, row => {
          if (!entry) {
            if (row.kind !== 'start' || row.id !== id || !row.area || !Object.hasOwn(operationAreaLabels, row.area)
              || !row.action || !Object.hasOwn(operationActionLabels, row.action) || validVersion(row.version) !== row.version) throw Error('Foreign file')
            entry = newEntry(row)
            entry.name = file.name
          } else applyRow(entry, row)
        })
      } catch { if (!entry) continue; entry.summary.complete = false }
      if (!entry) continue
      entry.size = size!
      if (entry.summary.outcome === 'running') {
        entry.summary.outcome = 'interrupted'
        entry.summary.endedAt = entry.summary.lastAt
        // 已切换数据目录的迁移需重启后才能验证，正常交接期间没有缺失的阶段。
        if (!entry.waitingForRestart) entry.summary.complete = false
        try { await updateHeader(operationPath(entry), entry.summary, entry.version) } catch { warn(entry) }
      }
      entries.set(id, entry)
      total += entry.size
    }
    await cleanup(0)
  }

  let ready = false
  // 目录写入权限恢复后，同一进程可以继续记录。
  async function initialize() {
    if (!ready) { await init(); ready = true }
  }
  let pending: Promise<void> = Promise.resolve().then(initialize).catch(() => warn())
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = pending.then(run)
    pending = next.then(() => {}, () => {})
    return next
  }
  let closing: Promise<void> | undefined
  function background(run: () => Promise<void>) { if (!closing) void enqueue(run).catch(() => warn()) }

  function candidates(): Candidate[] {
    const groups = new Map<string, Candidate>()
    const bound = new Map<string, string>()
    const recent = new Map<OperationArea, Candidate>()
    const failures = new Map<string, Candidate[]>()
    for (const [id, entry] of entries) {
      const s = entry.summary
      if (entry.binding) bound.set(entry.binding, id)
      if (s.endedAt === null || pins.has(id) || (entry.attachmentUntil ?? 0) > now()) continue
      const healthy = s.outcome === 'success' || s.outcome === 'cancelled'
      const candidate = { id, files: [] as ArchiveFile[], at: s.endedAt, priority: healthy ? Number(entry.retry) : 3 }
      groups.set(id, candidate)
      if (s.outcome === 'success' && (recent.get(s.area)?.at ?? -1) <= candidate.at) recent.set(s.area, candidate)
      if (!healthy) {
        const key = [s.area, s.action, entry.code ?? s.outcome].join('/')
        const list = failures.get(key) ?? []
        list.push(candidate); failures.set(key, list)
      }
    }
    for (const file of legacy.values()) {
      const owner = file.binding && bound.get(file.binding)
      if (owner && !groups.has(owner)) continue
      const key = owner || file.binding || file.path
      const group = groups.get(key) ?? { files: [], at: file.at, priority: 3 }
      group.files.push(file)
      if (!owner) group.at = Math.max(group.at, file.at)
      groups.set(key, group)
    }
    for (const item of recent.values()) item.priority = 2
    for (const list of failures.values()) {
      list.sort((a, b) => a.at - b.at)
      list[0].priority = 4
      list[list.length - 1].priority = 4
    }
    return [...groups.values()]
  }

  async function remove(candidate: Candidate) {
    const entry = candidate.id ? entries.get(candidate.id) : undefined
    const files = [...candidate.files]
    const primary = entry && operationPath(entry)
    if (entry?.size) files.push({ path: primary!, size: entry.size, at: candidate.at })
    function forgetFile(file: ArchiveFile) {
      total -= file.size
      legacy.delete(file.path)
      if (entry && file.path === primary) entry.size = 0
    }
    // 同一操作的现存文件一起移除；手动删掉的成员也应释放额度。
    const staged: { file: ArchiveFile; temporary: string }[] = []
    try {
      for (const file of files) {
        try {
          await checkedSize(file.path)
          if (files.length === 1) await unlink(file.path)
          else {
            const temporary = file.path + '.' + randomUUID() + '.deleting'
            await rename(file.path, temporary)
            staged.push({ file, temporary })
            continue
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        forgetFile(file)
      }
    } catch (error) {
      for (const { file, temporary } of staged.reverse()) await rename(temporary, file.path)
      throw error
    }
    for (const { file, temporary } of staged) {
      legacy.delete(file.path)
      try { await unlink(temporary); forgetFile(file) }
      catch { legacy.set(temporary, { ...file, path: temporary, binding: undefined }) }
    }
    if (candidate.id) entries.delete(candidate.id)
  }

  async function cleanup(incoming: number, expire = true, reserve = 0) {
    if (!expire && total + incoming + reserve <= maximum) return true
    const cutoff = now() - operationRetentionMs
    const pressure = total + incoming + reserve > maximum
    const items = candidates().sort((a, b) => Number(b.at <= cutoff) - Number(a.at <= cutoff) || a.priority - b.priority || a.at - b.at)
    for (const item of items) {
      if (item.at > cutoff && (!pressure || total + incoming + reserve <= target)) break
      try { await remove(item) } catch { /* 文件被占用时继续清理下一组。 */ }
    }
    return total + incoming + reserve <= maximum
  }

  async function persist(entry: Entry, row: Row, ordinary = false) {
    try {
      await initialize()
      await localLogDirectory(directory)
      const header = entry.size === 0 ? summaryHeader(entry.summary, entry.version) : ''
      const gap = entry.missing ? encodeRow({ kind: 'gap', at: row.at }, entry.summary.lastAt) : ''
      const text = header + gap + encodeRow(row, entry.summary.lastAt)
      const bytes = Buffer.byteLength(text)
      const activeCount = ordinary ? [...entries.values()].filter(item => item.summary.outcome === 'running').length : 0
      const reserve = ordinary ? activeCount * 640 : 0
      if (!await cleanup(bytes, false, reserve)) {
        if (ordinary) return false
        throw Error('Capacity')
      }
      const path = operationPath(entry)
      await allocated(bytes, async () => {
        if (!entry.size) await writeFile(path, text, { flag: 'wx', mode: 0o600 })
        else { await checkedSize(path); await appendFile(path, text) }
      })
      total += bytes; entry.size += bytes; entry.missing = false; warned = false
      return true
    } catch { warn(entry); return false }
  }

  async function write(entry: Entry, row: Row) {
    const previous = entry.summary.lastAt
    const recorded = await persist(entry, row)
    applyRow(entry, row)
    if (!recorded) entry.summary.lastAt = previous
    if (entry.size) {
      try { await checkedSize(operationPath(entry)); await updateHeader(operationPath(entry), entry.summary, entry.version) } catch { warn(entry) }
    }
  }
  function hold(state: { waiting?: Waiting }, row: Row) {
    if (state.waiting) { state.waiting.last = row; state.waiting.count++ }
    else state.waiting = { first: row, last: row, count: 1 }
  }
  function takeProgress(state: { waiting?: Waiting }, row?: Row): Row | undefined {
    const waiting = state.waiting
    if (!waiting) return row
    const last = row ?? waiting.last
    const first = waiting.first.fields
    const fromCount = first?.processed ?? first?.readCount ?? first?.validRecords ?? first?.count
    return { ...last, fields: { ...last.fields, merged: waiting.count + Number(!!row), fromAt: waiting.first.at,
      ...(typeof fromCount === 'number' && { fromCount }) } }
  }
  async function finalProgress(id: string, entry: Entry) {
    const state = progress.get(id)
    if (state?.waiting) await write(entry, takeProgress(state)!)
    progress.delete(id)
  }

  function begin(area: OperationArea, action: string, requested?: string) {
    const id = isOperationId(requested) ? requested : randomUUID(), at = now()
    const header: Row = { kind: 'start', id, at, area: Object.hasOwn(operationAreaLabels, area) ? area : 'startup',
      action: Object.hasOwn(operationActionLabels, action) ? action : 'operation', version: validVersion(version) }
    background(async () => {
      if (entries.has(id)) return
      const entry = newEntry(header)
      entries.set(id, entry)
      await persist(entry, header)
    })
    return id
  }
  function event(id: string, stage: string, fields?: Record<string, unknown>, options?: { progress?: boolean; retry?: boolean }) {
    const row: Row = { at: now(), kind: options?.retry ? 'retry' : options?.progress ? 'progress' : 'event',
      stage: Object.hasOwn(stageLabels, stage) ? stage : 'step', fields: safeFields(fields) }
    background(async () => {
      const entry = entries.get(id)
      if (!entry || entry.summary.outcome !== 'running') return
      let state = progress.get(id)
      if (state && (state.stage !== row.stage || row.kind !== 'progress')) { await finalProgress(id, entry); state = undefined }
      if (row.kind !== 'progress') { await write(entry, row); return }
      const fields = JSON.stringify(row.fields)
      if (state?.fields === fields) return
      if (!state) { state = { stage: row.stage!, fields, at: -Infinity }; progress.set(id, state) }
      state.fields = fields
      if (row.at - state.at >= 10_000) {
        const merged = takeProgress(state, row)!
        if (await persist(entry, merged, true)) {
          applyRow(entry, merged); state.at = row.at; state.waiting = undefined; return
        }
      }
      hold(state, row)
    })
  }
  function end(id: string, outcome: Outcome, fields?: Record<string, unknown>) {
    const row: Row = { kind: 'end', at: now(), outcome, fields: safeFields(fields) }
    background(async () => {
      const entry = entries.get(id)
      if (!entry || entry.summary.outcome !== 'running') return
      await finalProgress(id, entry)
      await write(entry, row)
    })
  }
  function bind(id: string, taskId: string, createdAt: number) {
    if (!localId(taskId) || !Number.isSafeInteger(createdAt) || createdAt < 0) return
    const row: Row = { kind: 'bind', at: now(), taskId, createdAt }
    background(async () => {
      const entry = entries.get(id)
      if (entry && entry.binding !== taskBinding(entry.summary.area, taskId, createdAt)) await write(entry, row)
    })
  }
  function resume(id: string) {
    const row: Row = { kind: 'resume', at: now() }
    background(async () => {
      const entry = entries.get(id)
      if (entry && (entry.summary.outcome === 'interrupted' || entry.summary.outcome === 'unknown'
        || (entry.summary.area === 'import' && entry.summary.outcome === 'failed'))) {
        entry.summary.endedAt = null
        entry.summary.outcome = 'running'
        await write(entry, row)
      }
    })
  }

  async function withFile<T>(id: string, use: (path: string) => T | Promise<T>, preparingAttachment = false) {
    if (!isOperationId(id)) throw missingOperation()
    pins.set(id, (pins.get(id) ?? 0) + 1)
    try {
      const path = await enqueue(async () => {
        const entry = entries.get(id)
        if (!entry?.size) throw missingOperation()
        const path = operationPath(entry)
        try {
          await checkedSize(path)
          await updateHeader(path, entry.summary, entry.version)
        } catch {
          warn(entry)
          await checkedSize(path).catch(() => { throw missingOperation() })
        }
        return path
      })
      const result = await use(path)
      const entry = entries.get(id)
      if (preparingAttachment && entry) {
        // 系统查看器启动后，给用户留出切到浏览器并选择附件的时间。
        entry.attachmentUntil = Math.min(now() + 10 * 60_000, (entry.summary.endedAt ?? now()) + operationRetentionMs)
      }
      return result
    } finally {
      const count = (pins.get(id) ?? 1) - 1
      if (count) pins.set(id, count)
      else pins.delete(id)
    }
  }
  function prune() { return enqueue(async () => { if (ready) await cleanup(0) }) }
  const timer = setInterval(() => { void prune().catch(() => warn()) }, day)
  timer.unref()
  function close() {
    if (closing) return closing
    clearInterval(timer)
    const at = now()
    closing = enqueue(async () => {
      for (const [id, entry] of entries) {
        if (entry.summary.outcome !== 'running') continue
        await finalProgress(id, entry)
        if (!entry.waitingForRestart) await write(entry, { kind: 'end', at, outcome: 'interrupted' })
      }
    })
    return closing
  }
  return {
    begin, event, end, bind, resume, withFile,
    async findByTask(area: OperationArea, taskId: string, createdAt: number) {
      await pending
      const binding = taskBinding(area, taskId, createdAt)
      let latest: Entry | undefined
      for (const entry of entries.values()) {
        if (entry.binding === binding && (!latest || entry.summary.startedAt > latest.summary.startedAt
          || (entry.summary.startedAt === latest.summary.startedAt && entry.summary.lastAt >= latest.summary.lastAt))) latest = entry
      }
      return latest?.summary.id ?? null
    },
    async list() {
      await pending
      return [...entries.values()].map(entry => ({ ...entry.summary })).sort((a, b) => b.startedAt - a.startedAt)
    },
    writeManagedLog(directory: string, filename: string, record: unknown) {
      return enqueue(async () => {
        await initialize()
        const isImport = directory === join(root, 'import-errors')
        const bytes = Buffer.byteLength(JSON.stringify(record, null, 2) + '\n')
        const file = legacyFile(directory, filename, isImport, bytes)
        if (!file || (directory !== root && !isImport)) throw Error('Invalid log name')
        if (!await cleanup(bytes, false)) throw Error('Capacity')
        const prev = legacy.get(file.path)?.size ?? 0
        await allocated(bytes, () => writeLocalLog(directory, filename, record))
        total += bytes - prev
        legacy.set(file.path, file)
      })
    },
    writeCrashLog(name: string, text: string, write: () => void) {
      const bytes = Buffer.byteLength(text)
      const file = legacyFile(root, name, false, bytes)
      if (!file || (ready ? total : crashUsage(root)) + writingBytes + bytes > maximum) return false
      write()
      if (ready) { legacy.set(file.path, file); total += bytes }
      return true
    },
    flush: () => pending, prune, close,
  }
}
export type OperationDiagnostics = ReturnType<typeof createOperationDiagnostics>
