import { afterEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createAppErrorLogs } from '../../electron/main/app-error-logs'
import { createImportDiagnostics } from '../../electron/main/import-diagnostics'
import { BoundaryError } from '../../src/shared/desktop-validation'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) === resolve(tmpdir()) && basename(root).startsWith('whomi-error-logs-')) await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = resolve(await mkdtemp(join(tmpdir(), 'whomi-error-logs-')))
  roots.push(root)
  const data = join(root, 'data'), profile = join(root, 'profile')
  await Promise.all([mkdir(data), mkdir(profile)])
  const openPath = vi.fn(async (_path: string) => '')
  const appLogs = () => createAppErrorLogs(profile, '0.1.test', openPath)
  return { data, profile, openPath, appLogs }
}

test('opens an empty log folder and keeps model, insight and import diagnostics available after restart', async () => {
  const { data, profile, openPath, appLogs } = await fixture()
  const first = appLogs()
  await first.setStorageDirectory(data)
  const path = join(data, 'logs')
  await expect(first.open('current')).resolves.toEqual({ path, fallback: false })
  expect(await readdir(path)).toEqual([])
  const imports = createImportDiagnostics(profile, '0.1.test', openPath, undefined, first)
  await Promise.all([
    first.record({ area: 'model', phase: 'testModel', error: new BoundaryError('MODEL_REQUEST_FAILED', 'private chat text and sk-synthetic') }),
    first.record({ area: 'insight', phase: 'writing', taskId: '17', analyzedMessages: 9,
      error: new BoundaryError('INSIGHT_BUDGET_EXHAUSTED'), budget: { name: 'maxCalls', limit: 64 } }),
    imports.report({ phase: 'parse', code: 'INVALID_RECORD', jobId: '3' }),
  ])
  const reopened = appLogs()
  await reopened.setStorageDirectory(data)
  await expect(reopened.open('current')).resolves.toEqual({ path, fallback: false })
  const names = await readdir(path)
  const model = await readFile(join(path, names.find(name => name.includes('-model-'))!), 'utf8')
  expect(model).not.toMatch(/private chat|sk-synthetic/)
  expect(JSON.parse(model)).toMatchObject({ recordedAt: expect.any(String), phase: 'testModel', code: 'MODEL_REQUEST_FAILED' })
  expect(JSON.parse(await readFile(join(path, names.find(name => name.includes('-insight-17-'))!), 'utf8')))
    .toMatchObject({ area: 'insight', phase: 'writing', taskId: '17', analyzedMessages: 9, budget: { name: 'maxCalls', limit: 64 } })
  await createImportDiagnostics(profile, '0.1.test', openPath, undefined, reopened).open('3')
  expect(dirname(openPath.mock.lastCall![0])).toBe(join(path, 'import-errors'))
})

test('falls back for all writers when the data log directory cannot be written and finds old import files', async () => {
  const { data, profile, openPath, appLogs } = await fixture()
  await createImportDiagnostics(profile, '0.0.old', openPath).report({ phase: 'parse', code: 'INVALID_RECORD', jobId: '7' })
  await writeFile(join(data, 'logs'), 'blocks the directory')
  const app = appLogs()
  await app.setStorageDirectory(data)
  const imports = createImportDiagnostics(profile, '0.1.test', openPath, undefined, app)
  await imports.report({ phase: 'parse', code: 'INVALID_RECORD', jobId: '8' })
  await app.record({ area: 'renderer', phase: 'console', error: new BoundaryError('SECRET_FROM_UNTRUSTED_OUTPUT') })
  const backup = join(profile, 'logs')
  await expect(app.open('current')).resolves.toEqual({ path: backup, fallback: true })
  const names = await readdir(backup)
  const renderer = await readFile(join(backup, names.find(name => name.includes('-renderer-'))!), 'utf8')
  expect(JSON.parse(renderer)).toMatchObject({ code: 'OPERATION_FAILED' })
  expect(renderer).not.toContain('SECRET')
  expect(await app.getArchives()).toEqual(['legacy-import'])
  await app.open('legacy-import')
  expect(openPath.mock.lastCall![0]).toBe(join(profile, 'import-errors'))
  await imports.open('7')
  expect(dirname(openPath.mock.lastCall![0])).toBe(join(profile, 'import-errors'))
  await imports.open('8')
  expect(dirname(openPath.mock.lastCall![0])).toBe(join(backup, 'import-errors'))
})

test('uses the user profile without a separate data drive and reports a location that cannot be written', async () => {
  const { data, profile, openPath, appLogs } = await fixture()
  const app = appLogs()
  await expect(app.open('current')).resolves.toEqual({ path: join(profile, 'logs'), fallback: false })
  await rmdir(join(profile, 'logs'))
  await writeFile(join(profile, 'logs'), 'blocked')
  await writeFile(join(data, 'logs'), 'also blocked')
  await app.setStorageDirectory(data)
  await expect(app.open('current')).rejects.toMatchObject({ code: 'ERROR_LOG_UNWRITABLE', action: expect.stringContaining('目录权限') })
  expect(openPath).toHaveBeenCalledTimes(1)
  await expect(app.open('D:/arbitrary' as 'current')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

test('replaying an unresolved import after upgrade preserves the original file with its time and counts', async () => {
  const { data, profile, openPath, appLogs } = await fixture()
  const job = { phase: 'parse', code: 'INVALID_RECORD', jobId: '4' }
  const counts = { seen: 9, validRecords: 8, invalidRecords: 1 }
  const created = Date.now() - 1000
  const legacy = createImportDiagnostics(profile, '0.1.10', openPath)
  await legacy.report(job, counts, created)
  await legacy.open('4')
  const original = openPath.mock.lastCall![0]
  const first = await readFile(original, 'utf8')
  const app = appLogs()
  await app.setStorageDirectory(data)
  const current = createImportDiagnostics(profile, '0.1.11', openPath, undefined, app)
  await current.report(job, counts, created)
  expect(await readdir(join(data, 'logs', 'import-errors'))).toEqual([])
  await current.open('4')
  expect(openPath.mock.lastCall![0]).toBe(original)
  expect(await readFile(original, 'utf8')).toBe(first)
  expect(JSON.parse(first)).toMatchObject({ version: '0.1.10', counts, recordedAt: expect.any(String) })
})

test('opens the enriched copy when the original and the copy share a filename across fallback locations', async () => {
  const { data, profile, openPath, appLogs } = await fixture()
  const job = { phase: 'parse', code: 'IMPORT_FAILED', jobId: '4' }
  const counts = { seen: 9, validRecords: 8, invalidRecords: 1 }
  const date = Date.now() - 1000
  const logs = join(data, 'logs')
  await writeFile(logs, 'fixture blocks the directory')
  const first = appLogs()
  await first.setStorageDirectory(data)
  await createImportDiagnostics(profile, '0.1.10', openPath, undefined, first).report(job, undefined, date)
  const [original] = await readdir(join(profile, 'logs', 'import-errors'))
  await unlink(logs)
  const second = appLogs()
  await second.setStorageDirectory(data)
  const current = createImportDiagnostics(profile, '0.1.11', openPath, undefined, second)
  await current.report({ ...job, code: 'INVALID_RECORD' }, counts, date)
  await second.withWritableRoot(async path => { if (path === logs) throw new Error('fixture write failure') })
  await current.open('4')
  const file = join(logs, 'import-errors', original)
  expect(openPath.mock.lastCall![0]).toBe(file)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ counts, code: 'INVALID_RECORD', version: '0.1.10' })
})
