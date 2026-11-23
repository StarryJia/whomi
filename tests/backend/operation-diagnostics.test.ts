import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createOperationDiagnostics } from '../../electron/main/operation-diagnostics'
import { createAppErrorLogs } from '../../electron/main/app-error-logs'
import { createImportDiagnostics } from '../../electron/main/import-diagnostics'
import { encodeRow, summaryHeader } from '../../electron/main/operation-text'

vi.mock('node:fs/promises', async importActual => {
  const fs = await importActual<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename), appendFile: vi.fn(fs.appendFile) }
})

const roots: string[] = []
const opened: ReturnType<typeof createOperationDiagnostics>[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'whomi-operation-test-'))
  roots.push(root)
  return root
}

function create(root: string, options?: Parameters<typeof createOperationDiagnostics>[2]) {
  const store = createOperationDiagnostics(root, '1.2.3', options)
  opened.push(store)
  return store
}

function contents(store: ReturnType<typeof createOperationDiagnostics>, id: string) {
  return store.withFile(id, path => readFile(path, 'utf8'))
}

test('keeps same-minute operations isolated and filters payloads before writing or exporting', async () => {
  const root = await directory()
  const log = create(root)
  const a = log.begin('import', 'import'), b = log.begin('model', 'test')
  log.bind(a, '1', 12345)
  log.event(a, 'read', { count: 8, filename: 'PRIVATE PERSON', code: 'PRIVATE_MESSAGE', token: 'PRIVATE_TOKEN' })
  log.event(b, 'write', { count: 53 })
  log.end(a, 'success', { count: 17 })
  log.end(b, 'failed')
  const preview = await contents(log, a)
  expect(preview).toContain(a)
  expect(preview).toContain('完整')
  expect(preview).toContain('17')
  expect(preview).not.toContain(b)
  expect(await contents(log, a)).toBe(preview)
  const path = await log.withFile(a, path => path)
  expect(await readFile(path, 'utf8')).not.toContain('PRIVATE')
  expect(preview).not.toContain('PRIVATE')
  expect(await log.findByTask('import', '1', 12345)).toBe(a)
  expect(await log.findByTask('import', '1', 54321)).toBe(null)
})

test('recovering a task keeps its operation id while a user-initiated attempt starts a new operation', async () => {
  const root = await directory()
  const first = create(root)
  const a = first.begin('insight', 'generate')
  first.bind(a, '12', 42)
  first.event(a, 'read', { count: 3 })
  await first.close()
  const next = create(root)
  expect(await next.findByTask('insight', '12', 42)).toBe(a)
  expect((await next.list())[0]).toMatchObject({ outcome: 'interrupted' })
  next.resume(a); next.event(a, 'read', { count: 4 }); next.end(a, 'success')
  const b = next.begin('insight', 'generate')
  expect(a).not.toBe(b)
  expect((await contents(next, a))).toContain('恢复')
})

test.each([false, true])('migration handoff preserves completeness across restart (missing stage: %s)', async missingStage => {
  const root = await directory()
  const first = create(root)
  const id = first.begin('storage', 'migrate')
  await first.flush()
  if (missingStage) vi.mocked(appendFile).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))
  first.event(id, 'switchDirectory')
  first.event(id, 'waitingForRestart')
  const path = await first.withFile(id, path => path)
  await first.close()
  expect(await readFile(path, 'utf8')).toContain('阶段=等待重启')
  expect(await readFile(path, 'utf8')).toContain('结果：进行中')
  const next = create(root)
  next.resume(id)
  next.event(id, 'reopen')
  next.end(id, 'success')
  expect(await next.list()).toEqual([expect.objectContaining({ id, outcome: 'success', complete: !missingStage })])
  expect(await contents(next, id)).toContain(missingStage ? '记录：不完整' : '记录：完整')
})

test('closing during import writes the latest coalesced count and interruption before the next launch', async () => {
  const root = await directory()
  let at = Date.now()
  const store = create(root, { now: () => at })
  const id = store.begin('import', 'import')
  store.event(id, 'parse', { count: 1 }, { progress: true })
  at += 1000
  store.event(id, 'parse', { count: 10 }, { progress: true })
  at += 1000
  store.event(id, 'parse', { count: 20 }, { progress: true })
  const path = await store.withFile(id, path => path)
  await store.close()
  const text = await readFile(path, 'utf8')
  expect(text).toContain('数量=20')
  expect(text).toContain('合并进度次数=2')
  expect(text).toContain('结果：中断')
  expect(text).toContain('记录：完整')
  const next = create(root)
  expect(await next.list()).toEqual([expect.objectContaining({ id, lastAt: at, outcome: 'interrupted', complete: true })])
})

test('expires ended operations at 30 days and protects live operations, an export and user files', async () => {
  const day = 86_400_000
  let time = 1_700_000_000_000
  const root = await directory()
  const log = create(root, { now: () => time })
  const old = log.begin('storage', 'migrate'), pinned = log.begin('model', 'test'), live = log.begin('startup', 'launch')
  log.end(old, 'success'); log.end(pinned, 'success')
  await log.flush()
  time += day
  const fresh = log.begin('insight', 'generate'); log.end(fresh, 'failed'); await log.flush()
  const file = join(root, 'logs', 'notes.txt')
  await writeFile(file, 'user file')
  await log.withFile(pinned, async () => {
    time += day * 29
    await log.prune()
    expect((await log.list()).map(s => s.id).sort()).toEqual([pinned, fresh, live].sort())
  })
  await log.prune()
  expect((await log.list()).map(s => s.id).sort()).toEqual([fresh, live].sort())
  expect(await readFile(file, 'utf8')).toBe('user file')
})

test('throttles changing progress, keeps final counts and always records retries', async () => {
  const root = await directory()
  let time = 1_700_000_000_000
  const log = create(root, { now: () => time })
  const id = log.begin('insight', 'generate')
  for (let i = 1; i <= 12; i++) {
    log.event(id, 'read', { count: i }, { progress: true })
    time += 1000
  }
  log.event(id, 'read', { attempt: 2 }, { retry: true })
  log.end(id, 'success')
  const text = await contents(log, id)
  expect(text).toContain('12')
  expect(text).toContain('重试')
  const rows = text.split('\n')
  expect(rows.filter(row => row.includes('  进度  ')).length).toBeLessThanOrEqual(3)
})

test('keeps a handed-off attachment available during capacity cleanup without renewing its retention', async () => {
  const root = await directory()
  let time = 1_700_000_000_000
  const options = { maxBytes: 4200, targetBytes: 2700, now: () => time }
  const first = create(root, options)
  const id = first.begin('conversation', 'open'); first.end(id, 'success')
  const path = await first.withFile(id, path => path, true)
  await first.close()
  const log = create(root, options)
  for (let i = 0; i < 12; i++) {
    time += 1000
    const other = log.begin('conversation', 'open'); log.end(other, 'success')
  }
  await log.flush()
  expect(await readFile(path, 'utf8')).toContain(id)
  time += 30 * 86_400_000
  await log.prune()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each([false, true])('a legacy import attachment protects its complete group through handoff and restart (bound: %s)', async bound => {
  const root = await directory(), dir = join(root, 'logs', 'import-errors')
  const started = Date.now()
  let at = started
  const options = { now: () => at, maxBytes: 4200, targetBytes: 2200 }
  const store = create(root, options)
  await store.flush()
  await mkdir(dir)
  let timeline: string | undefined
  if (bound) {
    const id = store.begin('import', 'import')
    store.bind(id, '4', at)
    store.end(id, 'failed')
    timeline = await store.withFile(id, path => path)
  }
  const name = `${at}-${randomUUID()}-${bound ? at + '-' : ''}4.txt`
  const record = { version: '0.1.10', recordedAt: new Date(at).toISOString(), phase: 'parse', code: 'INVALID_RECORD' }
  await store.writeManagedLog(dir, name, record)
  const path = join(dir, name), original = await readFile(path)
  const viewer = vi.fn(async (selected: string) => {
    expect(selected).toBe(path)
    const active = store.begin('import', 'import')
    for (let i = 0; i < 60; i++) store.event(active, 'read', { count: i })
    await store.flush()
    expect(await readFile(selected)).toEqual(original)
    return ''
  })
  const app = createAppErrorLogs(root, root, '1.2.3', viewer)
  await createImportDiagnostics(root, '1.2.3', file => store.openLegacyFile(file, viewer), undefined, app).open('4')
  expect(viewer).toHaveBeenCalledOnce()
  await store.close()

  const next = create(root, options)
  at += 9 * 60_000
  const active = next.begin('import', 'import')
  for (let i = 0; i < 90; i++) next.event(active, 'read', { count: i })
  await next.flush()
  expect(await readFile(path)).toEqual(original)
  if (timeline) expect(await readFile(timeline, 'utf8')).toContain('结果：失败')
  at = started + 10 * 60_000
  for (let i = 0; i < 10; i++) next.event(active, 'read', { count: i })
  await next.flush()
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  if (timeline) await expect(stat(timeline)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('opening a legacy file just before its 30-day deadline cannot extend retention after restart', async () => {
  const root = await directory(), start = Date.now()
  let at = start
  const store = create(root, { now: () => at }), dir = join(root, 'logs', 'import-errors')
  await store.flush()
  await mkdir(dir)
  const name = start + '-' + randomUUID() + '-4.txt', path = join(dir, name)
  await store.writeManagedLog(dir, name, { recordedAt: new Date(start).toISOString(), version: '1.2.3', phase: 'parse', code: 'INVALID_RECORD' })
  at += 30 * 86_400_000 - 1000
  await store.openLegacyFile(path, async () => '')
  await store.close()
  at += 1000
  const reopened = create(root, { now: () => at })
  await reopened.flush()
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('Explorer sees the latest persisted progress time and duration while the operation is running', async () => {
  const root = await directory()
  let at = Date.now()
  const store = create(root, { now: () => at })
  const id = store.begin('import', 'import')
  const path = await store.withFile(id, path => path)
  store.event(id, 'parse', { count: 1 }, { progress: true })
  at += 12_000
  store.event(id, 'parse', { count: 8 }, { progress: true })
  await store.flush()
  const text = await readFile(path, 'utf8')
  expect(text).toContain('耗时：12000 ms')
  expect(Date.parse(text.match(/最后已记录：(.+)/)![1])).toBe(at)
  expect(text).toContain('数量=8')
})

test.each(['failed', 'success'] as const)('a confirmed %s survives restart when the end row could not be appended', async outcome => {
  const root = await directory(), started = Date.now()
  let at = started
  const store = create(root, { now: () => at })
  const id = store.begin('import', 'import')
  const path = await store.withFile(id, path => path)
  at += 100
  vi.mocked(appendFile).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))
  store.end(id, outcome)
  await store.close()
  const original = await readFile(path, 'utf8')
  expect(original).not.toContain('  结束  ')
  const reopened = create(root, { now: () => at })
  expect(await reopened.list()).toEqual([expect.objectContaining({ id, outcome, endedAt: at, lastAt: started, complete: false })])
  expect(await readFile(path, 'utf8')).toBe(original)
})

test.each([false, true])('a newer durable resume wins over a same-millisecond stale terminal header (incomplete: %s)', async incomplete => {
  const root = await directory(), at = Date.now()
  const store = create(root, { now: () => at }), id = store.begin('import', 'import')
  const path = await store.withFile(id, path => path)
  if (incomplete) {
    vi.mocked(appendFile).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))
    store.event(id, 'parse')
  }
  store.end(id, 'failed', { code: 'INVALID_RECORD' })
  await store.close()
  // 模拟恢复行已追加、但改写摘要前进程退出。
  await appendFile(path, encodeRow({ kind: 'resume', at }, at))
  const reopened = create(root, { now: () => at })
  expect(await reopened.list()).toEqual([expect.objectContaining({ id, outcome: 'interrupted', complete: false })])
})

test('a newer confirmed summary supersedes the old terminal row when both resumed writes fail', async () => {
  const root = await directory(), start = Date.now()
  let at = start
  const store = create(root, { now: () => at }), id = store.begin('import', 'import')
  store.end(id, 'unknown', { code: 'INVALID_RECORD' })
  await store.flush()
  at += 100
  const full = Object.assign(new Error('full'), { code: 'ENOSPC' })
  vi.mocked(appendFile).mockRejectedValueOnce(full).mockRejectedValueOnce(full)
  store.resume(id)
  store.end(id, 'success')
  await store.close()
  const reopened = create(root, { now: () => at })
  const [summary] = await reopened.list()
  expect(summary).toMatchObject({ id, outcome: 'success', lastAt: start, endedAt: at, complete: false })
  expect(summary.endCode).toBeUndefined()
})

test('a partial end-row write preserves its actual byte count, result and later recovery across two restarts', async () => {
  const root = await directory(), start = Date.now()
  let at = start
  const store = create(root, { now: () => at }), id = store.begin('import', 'import')
  const path = await store.withFile(id, path => path), before = (await stat(path)).size
  const append = vi.mocked(appendFile).getMockImplementation()!
  vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
    await append(file, Buffer.from(String(data)).subarray(0, 13))
    throw Object.assign(new Error('full'), { code: 'ENOSPC' })
  })
  at += 150
  store.end(id, 'failed')
  await store.close()
  expect((await stat(path)).size).toBe(before + 13)
  const reopened = create(root, { now: () => at })
  expect(await reopened.list()).toEqual([expect.objectContaining({ id, complete: false, outcome: 'failed', lastAt: start, endedAt: at })])
  expect(await readFile(path, 'utf8')).toContain('已记录字节数：' + (before + 13))
  at += 50
  reopened.resume(id)
  reopened.end(id, 'success')
  await reopened.close()
  const again = create(root, { now: () => at })
  expect(await again.list()).toEqual([expect.objectContaining({ id, complete: false, outcome: 'success', endedAt: at })])
  const text = await readFile(path, 'utf8')
  expect(text).toMatch(/(?:^|\n)\S+  \+\d+ ms  恢复\n/)
  expect(text).not.toContain('完整行截止字节')
})

test('an older incomplete header with no byte count recovers a same-millisecond confirmed result', async () => {
  const root = await directory(), at = Date.now()
  const store = create(root, { now: () => at }), id = store.begin('import', 'import')
  const path = await store.withFile(id, path => path)
  vi.mocked(appendFile).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))
  store.end(id, 'failed')
  await store.close()
  const [summary] = await store.list()
  const oldHeader = Buffer.from(summaryHeader(summary, '1.2.3'))
  await writeFile(path, Buffer.concat([oldHeader, (await readFile(path)).subarray(oldHeader.length)]))
  const reopened = create(root, { now: () => at })
  expect(await reopened.list()).toEqual([expect.objectContaining({ id, outcome: 'failed', complete: false })])
})

test('discarding a duplicate removes only its untouched provisional log and releases its capacity', async () => {
  const root = await directory(), store = create(root, { maxBytes: 3200, targetBytes: 2000 })
  const confirmed = store.begin('insight', 'generate')
  store.bind(confirmed, '1', Date.now())
  const observed = store.begin('conversation', 'send')
  store.event(observed, 'request')
  await store.discardUnstarted(confirmed)
  await store.discardUnstarted(observed)
  for (let i = 0; i < 8; i++) {
    const duplicate = store.begin('insight', 'generate')
    await store.discardUnstarted(duplicate)
  }
  store.end(confirmed, 'success')
  store.end(observed, 'success')
  expect((await store.list()).map(entry => [entry.id, entry.complete])).toEqual(expect.arrayContaining([[confirmed, true], [observed, true]]))
  expect(await readdir(join(root, 'logs', 'operations'))).toHaveLength(2)
})

test.each(['processed', 'readCount', 'validRecords'])('merges the actual starting and final progress counters for %s', async counter => {
  let time = 1_700_000_000_000
  const log = create(await directory(), { now: () => time++ })
  const id = log.begin(counter === 'readCount' ? 'insight' : 'import', counter === 'readCount' ? 'generate' : 'import')
  for (const value of [1, 2, 20]) log.event(id, 'read', { [counter]: value }, { progress: true })
  log.end(id, 'success')
  const text = await contents(log, id)
  expect(text).toContain('起始计数=2')
  expect(text).toMatch(/=20 .*起始计数=2/)
})

test('a task spanning midnight expires as one file 30 days after its last result', async () => {
  let time = new Date(2026, 9, 1, 23, 59, 59).getTime()
  const start = time, log = create(await directory(), { now: () => time })
  const id = log.begin('insight', 'generate')
  log.event(id, 'reading', { readCount: 10 })
  time += 2000
  log.end(id, 'failed', { code: 'MODEL_TIMEOUT' })
  await log.flush()
  time = start + 30 * 86_400_000
  await log.prune()
  const path = await log.withFile(id, path => path)
  const timeline = await readFile(path, 'utf8')
  expect(timeline).toContain('23:59:59')
  expect(timeline).toContain('00:00:01')
  time += 2000
  await log.prune()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('pressure deletes each operation as a unit, retains bookend failures and does not touch attachments', async () => {
  const root = await directory()
  let at = 1_700_000_000_000
  const log = create(root, { maxBytes: 7300, targetBytes: 5200, now: () => ++at })
  const failures: string[] = []
  for (let i = 0; i < 5; i++) {
    const id = log.begin('insight', 'generate')
    log.event(id, 'request', { attempt: 1 })
    log.event(id, 'requestFailed', { code: 'MODEL_TIMEOUT' })
    log.end(id, 'failed', { code: 'MODEL_TIMEOUT' })
    failures.push(id)
  }
  const ordinary = log.begin('insight', 'generate')
  log.end(ordinary, 'success')
  const other = log.begin('insight', 'generate')
  log.end(other, 'success')
  await log.flush()
  const location = join(root, 'logs', 'operations')
  const attachment = join(location, '我的工单附件.txt')
  await writeFile(attachment, 'user')
  const running = log.begin('import', 'import')
  let removed = false
  for (let j = 0; j < 30; j++) {
    log.event(running, 'parse', { count: j })
    const ids = (await log.list()).map(x => x.id)
    if (ids.includes(ordinary)) continue
    removed = true
    expect(ids).toContain(failures[0]); expect(ids).toContain(failures.at(-1))
    const sizes = await Promise.all((await readdir(location)).filter(n => n.endsWith('.txt') && /^\d/.test(n)).map(async name => (await stat(join(location, name))).size))
    expect(sizes.reduce((a, b) => a+b, 0)).toBeLessThanOrEqual(5200)
    break
  }
  expect(removed).toBe(true)
  for (const id of [failures[0], failures.at(-1)!]) {
    const text = await contents(log, id)
    expect(text).toContain('请求发起'); expect(text).toContain('MODEL_TIMEOUT'); expect(text).toContain('失败')
  }
  expect(await readFile(attachment, 'utf8')).toBe('user')
})

test('preserves the running start, compacted progress and terminal failure when space is tight', async () => {
  const root = await directory()
  let at = 1_700_000_000_000
  const log = create(root, { maxBytes: 2200, targetBytes: 1600, now: () => at })
  const id = log.begin('import', 'import')
  for (let i = 0; i < 100; i++) {
    at += 11_000
    log.event(id, 'parse', { count: i }, { progress: true })
  }
  log.end(id, 'failed', { code: 'INVALID_RECORD' })
  const text = await contents(log, id)
  expect(text).toContain('合并进度次数'); expect(text).toContain('数量=99'); expect(text).toContain('INVALID_RECORD')
  expect(await log.withFile(id, async path => (await stat(path)).size)).toBeLessThanOrEqual(2200)
})

test('a filesystem failure leaves a visible gap and is never reported as a confirmed success', async () => {
  const root = await directory(), notify = vi.fn()
  const log = create(root, { onWriteFailure: notify })
  const id = log.begin('import', 'import')
  log.event(id, 'scan', { count: 1 }); await log.flush()
  const dir = join(root, 'logs', 'operations')
  await rename(dir, dir + '-offline')
  await writeFile(dir, 'occupied')
  log.event(id, 'parse', { count: 7 })
  await log.flush(); expect(notify).toHaveBeenCalledTimes(1)
  await rm(dir); await rename(dir + '-offline', dir)
  log.end(id, 'unknown')
  const text = await contents(log, id)
  expect(text).toContain('记录不完整'); expect(text).toContain('结果未知'); expect(text).not.toContain('数量=7')
  await log.close()
  const next = create(root)
  expect((await next.list())[0]).toMatchObject({complete: false, outcome: 'unknown'})
})

test('legacy errors share the quota and expire while unrelated and exported files survive', async () => {
  const root = await directory(), clock = Date.now()
  let now = clock
  const log = create(root, { now: () => now })
  const old = createAppErrorLogs(root, root, '1.2.3', async () => '')
  old.setOperationDiagnostics(log)
  await old.record({ area: 'main', phase: 'startup', error: new Error('private') })
  const dir = join(root, 'logs')
  const owned = (await readdir(dir)).find(name => name.endsWith('.json'))!
  const user = join(dir, owned.replace('-main-', '-data-'))
  await writeFile(user, 'private notes')
  now += 31 * 86_400_000
  await log.prune()
  expect(await readdir(dir)).not.toContain(owned)
  expect(await readFile(user, 'utf8')).toBe('private notes')
})

test.each(['standalone', 'timeline', 'legacy'])('external removal of a %s file releases quota for the next operation', async removed => {
  const root = await directory(), now = Date.now(), notify = vi.fn()
  const store = create(root, { now: () => now, maxBytes: 1250, targetBytes: 950, onWriteFailure: notify })
  const old = store.begin('import', 'import')
  store.bind(old, '4', now)
  store.end(old, 'failed')
  const timeline = await store.withFile(old, path => path)
  const archiveDirectory = join(root, 'logs', 'import-errors')
  await mkdir(archiveDirectory)
  const archiveName = now + '-' + randomUUID() + '-' + now + '-4.txt'
  if (removed !== 'standalone') await store.writeManagedLog(archiveDirectory, archiveName,
    { recordedAt: new Date(now).toISOString(), version: '1.2.3', phase: 'parse', code: 'INVALID_RECORD' })
  await rm(removed === 'legacy' ? join(archiveDirectory, archiveName) : timeline)
  const current = store.begin('import', 'import')
  store.end(current, 'success')
  expect(await contents(store, current)).toContain('结果：成功')
  expect(await store.list()).toEqual([expect.objectContaining({ id: current, complete: true })])
  expect(await readdir(archiveDirectory)).toEqual([])
  expect(notify).not.toHaveBeenCalled()
})

test('releasing a locked group rolls back all members, skips to the next group and cleans it on a later pass', async () => {
  const root = await directory()
  let time = Date.now()
  const store = create(root, { now: () => time }), group = store.begin('import', 'import'), other = store.begin('model', 'test')
  store.bind(group, '4', 123)
  store.end(group, 'failed'); store.end(other, 'success')
  const path = await store.withFile(group, path => path)
  const { mkdir } = await import('node:fs/promises')
  const dir = join(root, 'logs', 'import-errors')
  await mkdir(dir)
  const name = String(time) + '-' + randomUUID() + '-123-4.txt'
  await store.writeManagedLog(dir, name, { recordedAt: new Date(time).toISOString(), version: '1.2.3', phase: 'parse', code: 'INVALID_RECORD' })
  const original = vi.mocked(rename).getMockImplementation()!
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (from === path) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    await original(from, to)
  })
  try {
    time += 30 * 86_400_000
    await store.prune()
    expect((await store.list()).map(s => s.id)).toEqual([group])
    expect(await readdir(dir)).toEqual([name])
    expect(await readFile(path, 'utf8')).toContain('失败')
  } finally { vi.mocked(rename).mockImplementation(original) }
  await store.prune()
  expect(await store.list()).toEqual([])
  expect(await readdir(dir)).toEqual([])
})

test('real ENOSPC write failures leave the last known time and a gap on the next confirmed write', async () => {
  const dir = await directory(), notify = vi.fn()
  let at = Date.now()
  const store = create(dir, { now: () => at, onWriteFailure: notify })
  const id = store.begin('import', 'import')
  await store.flush()
  const last = at++
  vi.mocked(appendFile).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))
  store.event(id, 'parse', { count: 8 })
  expect((await store.list())[0]).toMatchObject({ lastAt: last, complete: false })
  expect(notify).toHaveBeenCalledOnce()
  store.end(id, 'unknown')
  expect(await contents(store, id)).toContain('记录不完整')
})

test('startup reclaims owned temporary files without removing user files with the same extension', async () => {
  const dir = await directory(), first = create(dir), id = first.begin('startup', 'launch')
  first.end(id, 'success'); await first.close()
  const root = join(dir, 'logs'), name = String(Date.now()) + '-main-' + randomUUID() + '.json'
  const owned = join(root, '.whomi-' + name + '.' + randomUUID() + '.tmp'), user = join(root, '草稿.tmp')
  await writeFile(owned, 'partial'); await writeFile(user, 'my notes')
  const next = create(dir)
  expect((await next.list())[0].id).toBe(id)
  await expect(stat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(user, 'utf8')).toBe('my notes')
})

test('default 128 MiB boundary triggers whole-operation cleanup to at most 112 MiB', async () => {
  const dir = await directory(), first = create(dir), mib = 1_048_576
  const names: string[] = []
  for (let i = 0; i < 3; i++) {
    const id = first.begin('import', 'import')
    first.end(id, i === 0 ? 'failed' : 'success')
    names.push(await first.withFile(id, path => path))
  }
  await first.close()
  // 使用逻辑大小受控的合成历史文件，直接验证正式容量边界。
  const sizes = [100 * mib, 20 * mib, 8 * mib]
  const time = new Date().toISOString()
  const prefix = time + '  +0 ms  进度  阶段=解析  '
  const chunk = Buffer.from(prefix + '-'.repeat(65536 - Buffer.byteLength(prefix) - 1) + '\n')
  const block = Buffer.concat(Array(16).fill(chunk))
  const { open } = await import('node:fs/promises')
  for (const [i, path] of names.entries()) {
    const handle = await open(path, 'a')
    try {
      let remaining = sizes[i] - (await handle.stat()).size
      while (remaining >= block.length) { await handle.write(block); remaining -= block.length }
      if (remaining) await handle.write(Buffer.from(prefix + '-'.repeat(remaining - Buffer.byteLength(prefix) - 1) + '\n'))
    } finally { await handle.close() }
  }
  const next = create(dir)
  expect(await next.list()).toHaveLength(3)
  const id = next.begin('settings', 'settingsChange'); next.end(id, 'success'); await next.flush()
  const files = await readdir(join(dir, 'logs', 'operations'))
  const sizesAfter = await Promise.all(files.map(n => stat(join(dir, 'logs', 'operations', n)).then(s => s.size)))
  expect(sizesAfter.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(112 * mib)
  expect(await stat(names[0]).then(s => s.size)).toBe(100 * mib)
}, 30_000)
