import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { createDataDispatcher } from '../../electron/data/dispatch'
import { createDataService } from '../../electron/data/service'
import { createImportOperationTracker } from '../../electron/main/import-operation-tracker'
import { createOperationDiagnostics } from '../../electron/main/operation-diagnostics'
import { createDesktopRouter } from '../../electron/main/ipc'
import { createSourceGrants } from '../../electron/main/source-grants'
import type { ImportSnapshot } from '../../src/shared/import-contract'
import { BoundaryError } from '../../src/shared/desktop-validation'

it('correlates a file and folder before worker acknowledgement, including exact duplicate, rollback and refresh receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whomi-import-trace-'))
  const db = openStore(join(dir, 'test.db'))
  const privateText = 'PRIVATE_CHAT_DIAGNOSTIC_SENTINEL'
  const document = (count: number, groupId: string) => JSON.stringify({
    chatlab: { version: '0.0.2' }, meta: { name: privateText, platform: 'telegram', type: 'group', groupId, ownerId: 'self' },
    members: [{ platformId: 'self', accountName: privateText }],
    messages: Array.from({ length: count }, (_, i) => ({ sender: 'self', accountName: privateText,
      type: 0, timestamp: 1700000000 + i, platformMessageId: String(i + 1), content: privateText })),
  })
  const log = { begin: vi.fn(() => randomUUID()), end: vi.fn(), event: vi.fn(), bind: vi.fn(),
    findByTask: vi.fn(async () => null), list: vi.fn(async () => []), resume: vi.fn() }
  const tracker = createImportOperationTracker(log)
  const grants = createSourceGrants()
  let release = () => {}
  let gate = Promise.resolve()
  let rejectMethod: string | undefined
  const service = createDataService({ store: db, appDataDirectory: dir, changed: snapshot => router.publish(snapshot) })
  const dispatch = createDataDispatcher(db, service)
  const router = createDesktopRouter({ grants, imports: tracker, request: async (method, input) => {
    if (method === 'prepareImport') await gate
    if (method === rejectMethod) { rejectMethod = undefined; throw new BoundaryError('DATA_PROCESS_GONE') }
    return dispatch(method, input)
  } })
  const get = (jobId: string) => router.invoke(1, 'getImport', [jobId]) as Promise<ImportSnapshot>
  async function stage(path: string, origin: 'picker' | 'drop') {
    const handles = await grants.issue(1, [path], origin)
    gate = new Promise<void>(done => { release = done })
    const prepared = router.invoke(1, 'prepareImport', [handles]) as Promise<string>
    const id = log.begin.mock.results.at(-1)!.value
    expect(log.event).toHaveBeenCalledWith(id, 'accepted', { source: origin, sourceKind: handles[0].kind, sourceCount: 1 })
    expect(log.bind.mock.calls.some(call => call[0] === id)).toBe(false)
    release()
    const jobId = await prepared
    const scan = await get(jobId)
    expect(scan.operationId).toBe(id)
    expect(log.bind).toHaveBeenCalledWith(id, jobId, scan.jobCreatedAt)
    await router.invoke(1, 'startImport', [{ kind: 'stage', jobId, entryIds: scan.discovery!.entries.map(entry => entry.entryId) }])
    await service.idle()
    const snapshot = await get(jobId)
    return { id, jobId, scan, snapshot }
  }
  try {
    const file = join(dir, 'first.json'), folder = join(dir, 'folder')
    await mkdir(folder)
    await writeFile(file, document(98, 'a'))
    const first = await stage(file, 'picker')
    await router.invoke(1, 'startImport', [{ kind: 'commit', plan: { jobId: first.jobId, decisions: [] } }])
    await service.idle()
    const firstSaved = await get(first.jobId)
    expect(firstSaved.status).toBe('completed')
    await tracker.refresh(first.jobId, firstSaved.jobCreatedAt, 'success')
    expect(log.end).toHaveBeenCalledWith(first.id, 'success')
    expect(first.scan.discovery?.fileCount).toBe(1)

    const repeat = document(100, 'a'), another = document(1, 'b')
    await writeFile(join(folder, 'a.json'), repeat)
    await writeFile(join(folder, 'b.json'), another)
    const next = await stage(folder, 'drop')
    expect(next.id).not.toBe(first.id)
    expect(next.scan.discovery).toMatchObject({ fileCount: 2, totalBytes: Buffer.byteLength(repeat) + Buffer.byteLength(another) })
    const candidateIds = [next.snapshot.candidates.find(c => c.identity.conversationKey === 'a')!.candidateId]
    await router.invoke(1, 'startImport', [{ kind: 'commit', plan: { jobId: next.jobId, decisions: [], candidateIds } }])
    await service.idle()
    const receipt = await get(next.jobId)
    expect(receipt).toMatchObject({ inserted: 2, duplicates: 98 })
    expect(db.reader.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 100n })
    expect(log.event).toHaveBeenCalledWith(next.id, 'commit', { result: 'success', newCount: 0, appendCount: 1, inserted: 2, duplicates: 98 })
    await tracker.refresh(next.jobId, receipt.jobCreatedAt, 'failed')
    expect(log.event).toHaveBeenCalledWith(next.id, 'refresh', { result: 'failed' })
    expect(log.end).toHaveBeenCalledWith(next.id, 'failed')
    const third = await stage(folder, 'picker')
    await router.invoke(1, 'cancelImport', [third.jobId])
    expect((await get(third.jobId)).status).toBe('cancelled')
    await tracker.refresh(third.jobId, third.snapshot.jobCreatedAt, 'success')
    expect(log.event).toHaveBeenCalledWith(third.id, 'rollback', { result: 'success', inserted: 0, duplicates: 0 })
    expect(log.end).toHaveBeenCalledWith(third.id, 'cancelled')
    for (const [method, stageName] of [['startImport', 'commit'], ['cancelImport', 'rollback']]) {
      const delayed = await stage(file, 'picker')
      const args = method === 'startImport' ? [{ kind: 'commit', plan: { jobId: delayed.jobId, decisions: [] } }] : [delayed.jobId]
      rejectMethod = method
      await expect(router.invoke(1, method, args)).rejects.toMatchObject({ code: 'DATA_PROCESS_GONE' })
      expect(log.event).toHaveBeenCalledWith(delayed.id, stageName, { result: 'unknown', code: 'DATA_PROCESS_GONE' })
      expect(log.end).toHaveBeenCalledWith(delayed.id, 'unknown', { code: 'DATA_PROCESS_GONE' })
      // 后台最终给出同一已受理操作的实际结果。
      await dispatch(method, args)
      await service.idle()
      const confirmed = await get(delayed.jobId)
      const committed = method === 'startImport'
      expect(confirmed.status).toBe(committed ? 'completed' : 'cancelled')
      await tracker.refresh(delayed.jobId, confirmed.jobCreatedAt, 'success')
      expect(log.resume).toHaveBeenCalledWith(delayed.id)
      expect(log.end).toHaveBeenCalledWith(delayed.id, committed ? 'success' : 'cancelled')
    }
    expect(JSON.stringify(log.event.mock.calls)).not.toContain(privateText)
    expect(JSON.stringify(log.event.mock.calls)).not.toContain(dir)
  } finally {
    release()
    await service.idle()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('preserves 800 missing timestamps and their first three ordinals when a save fails and the user cancels after restart', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whomi-import-failed-trace-'))
  const db = openStore(join(dir, 'test.db'))
  let log = createOperationDiagnostics(dir, '0.1.11')
  let tracker = createImportOperationTracker(log)
  const service = createDataService({ store: db, appDataDirectory: dir, changed: snapshot => tracker.observe(snapshot),
    runner: { summary() { throw new Error('synthetic summary failure') } } })
  const dispatch = createDataDispatcher(db, service)
  const grants = createSourceGrants()
  const router = () => createDesktopRouter({ grants, imports: tracker, request: dispatch })
  try {
    const file = join(dir, 'broken.json')
    const raw = JSON.parse(await readFile('tests/fixtures/import/telegram-native-single/positive.json', 'utf8'))
    raw.messages = Array.from({ length: 800 }, (_, index) => ({ ...raw.messages[0], id: index + 1, date: undefined, date_unixtime: undefined }))
    await writeFile(file, JSON.stringify(raw))
    const first = router()
    const jobId = await first.invoke(1, 'prepareImport', [await grants.issue(1, [file], 'picker')])
    const initial = await first.invoke(1, 'getImport', [jobId]) as ImportSnapshot
    const id = initial.operationId!
    await first.invoke(1, 'startImport', [{ kind: 'stage', jobId, entryIds: initial.discovery!.entries.map(e => e.entryId) }])
    await service.idle()
    const parsed = await first.invoke(1, 'getImport', [jobId]) as ImportSnapshot
    expect(parsed.status).toBe('awaiting_commit')
    const fault = parsed.candidates[0].issues.find(issue => issue.occurrences === 800)!
    expect(fault.ordinals).toEqual([0, 1, 2])
    await first.invoke(1, 'startImport', [{ kind: 'commit', plan: { jobId, decisions: [] } }])
    await service.idle()
    expect(await first.invoke(1, 'getImport', [jobId])).toMatchObject({ status: 'failed', rolledBack: true })
    expect((await log.list())[0]).toMatchObject({ id, outcome: 'failed' })
    await log.close()
    log = createOperationDiagnostics(dir, '0.1.11')
    tracker = createImportOperationTracker(log)
    const next = router()
    await next.invoke(1, 'getImport', [jobId])
    await next.invoke(1, 'cancelImport', [jobId])
    const cancelled = await next.invoke(1, 'getImport', [jobId]) as ImportSnapshot
    expect(cancelled).toMatchObject({ status: 'cancelled', operationId: id })
    await tracker.refresh(cancelled.jobId, cancelled.jobCreatedAt, 'success')
    expect(await log.list()).toMatchObject([{ id, outcome: 'failed' }])
    const text = await log.withFile(id, path => readFile(path, 'utf8'))
    expect(text).toContain('阶段=异常记录汇总')
    expect(text).toContain('错误码=UNKNOWN_TIME')
    expect(text).toContain('数量=800')
    expect(text).toContain('记录序号=0,1,2')
    expect(text).toContain('阶段=整批撤回')
    expect(text).toContain('阶段=刷新')
    expect(text).not.toContain('Synthetic Telegram')
  } finally {
    await service.idle()
    await log.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
