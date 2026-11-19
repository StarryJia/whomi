import { afterEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
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
  const install = join(root, 'Whomi')
  await Promise.all([mkdir(data), mkdir(profile), mkdir(install)])
  const openPath = vi.fn(async (_path: string) => '')
  const onWriteFailure = vi.fn()
  const appLogs = () => createAppErrorLogs(install, profile, '0.1.test', openPath, onWriteFailure)
  return { install, data, profile, openPath, onWriteFailure, appLogs }
}

test('opens an empty log folder and keeps model, insight and import diagnostics available after restart', async () => {
  const { install, data, profile, openPath, appLogs } = await fixture()
  const first = appLogs()
  first.setDataArchives(data)
  const path = join(install, 'logs')
  await expect(first.open()).resolves.toEqual({ path })
  expect(await readdir(path)).toEqual([])
  const imports = createImportDiagnostics(profile, '0.1.test', openPath, undefined, first)
  await Promise.all([
    first.record({ area: 'model', phase: 'testModel', error: new BoundaryError('MODEL_REQUEST_FAILED', 'private chat text and sk-synthetic') }),
    first.record({ area: 'insight', phase: 'writing', taskId: '17', analyzedMessages: 9,
      error: new BoundaryError('INSIGHT_BUDGET_EXHAUSTED'), budget: { name: 'maxCalls', limit: 64 } }),
    imports.report({ phase: 'parse', code: 'INVALID_RECORD', jobId: '3' }),
  ])
  const reopened = appLogs()
  reopened.setDataArchives(data)
  await expect(reopened.open()).resolves.toEqual({ path })
  const names = await readdir(path)
  const model = await readFile(join(path, names.find(name => name.includes('-model-'))!), 'utf8')
  expect(model).not.toMatch(/private chat|sk-synthetic/)
  expect(JSON.parse(model)).toMatchObject({ recordedAt: expect.any(String), phase: 'testModel', code: 'MODEL_REQUEST_FAILED' })
  expect(JSON.parse(await readFile(join(path, names.find(name => name.includes('-insight-17-'))!), 'utf8')))
    .toMatchObject({ area: 'insight', phase: 'writing', taskId: '17', analyzedMessages: 9, budget: { name: 'maxCalls', limit: 64 } })
  await createImportDiagnostics(profile, '0.1.test', openPath, undefined, reopened).open('3')
  expect(dirname(openPath.mock.lastCall![0])).toBe(join(path, 'import-errors'))
})

test('opens only the installation directory while import tasks can still find their original files', async () => {
  const { install, data, profile, openPath, appLogs } = await fixture()
  const logs = appLogs()
  await expect(logs.open()).resolves.toEqual({ path: join(install, 'logs') })
  await mkdir(join(profile, 'logs'))
  await mkdir(join(data, 'logs'))
  await writeFile(join(profile, 'logs', 'older-model.json'), '{}')
  await createImportDiagnostics(join(data, 'logs'), 'old', openPath).report({ phase: 'parse', code: 'INVALID_RECORD', jobId: '7' })
  await createImportDiagnostics(profile, 'old', openPath).report({ phase: 'parse', code: 'INVALID_RECORD', jobId: '8' })
  logs.setDataArchives(data)
  await logs.open()
  expect(openPath.mock.lastCall![0]).toBe(join(install, 'logs'))
  const imports = createImportDiagnostics(profile, 'new', openPath, undefined, logs)
  await imports.open('7')
  expect(dirname(openPath.mock.lastCall![0])).toBe(join(data, 'logs', 'import-errors'))
  await imports.open('8')
  expect(dirname(openPath.mock.lastCall![0])).toBe(join(profile, 'import-errors'))
})

test('reports the installation path when writing fails and resumes there after access returns', async () => {
  const { install, data, profile, openPath, onWriteFailure, appLogs } = await fixture()
  const logs = appLogs()
  logs.setDataArchives(data)
  const path = join(install, 'logs')
  await writeFile(path, 'blocked')
  await logs.record({ area: 'model', phase: 'generate', error: new BoundaryError('CHATGPT_LIMIT') })
  const imports = createImportDiagnostics(profile, 'test', openPath, undefined, logs)
  await expect(imports.report({ phase: 'parse', code: 'INVALID_RECORD' })).rejects.toMatchObject({ action: expect.stringContaining(path) })
  await expect(logs.open()).rejects.toMatchObject({ code: 'ERROR_LOG_UNWRITABLE', action: expect.stringContaining(path) })
  expect(openPath).not.toHaveBeenCalled()
  expect(onWriteFailure).toHaveBeenCalledWith(expect.stringContaining(path))
  expect(await readdir(data)).toEqual([])
  expect(await readdir(profile)).toEqual([])
  await unlink(path)
  await imports.report({ phase: 'parse', code: 'INVALID_RECORD' })
  await expect(logs.open()).resolves.toEqual({ path, missedRecords: 2 })
  expect(await readdir(join(path, 'import-errors'))).toHaveLength(1)
})

test('delivers a pre-window write failure once to the first listener and clears it after recovery', async () => {
  const { install, profile, openPath } = await fixture()
  const logs = createAppErrorLogs(install, profile, 'test', openPath)
  const path = join(install, 'logs')
  await writeFile(path, 'read-only fixture')
  await logs.record({ area: 'main', phase: 'startup', error: new Error() })
  const report = vi.fn()
  logs.setWriteFailureListener(report)
  logs.setWriteFailureListener(report)
  await logs.record({ area: 'model', phase: 'testModel', error: new Error() })
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(path))
  await unlink(path)
  await logs.record({ area: 'main', phase: 'retry', error: new Error() })
  const next = vi.fn()
  logs.setWriteFailureListener(next)
  expect(next).not.toHaveBeenCalled()
})

test('replaying an unresolved import after upgrade preserves the original file with its time and counts', async () => {
  const { install, data, profile, openPath, appLogs } = await fixture()
  const job = { phase: 'parse', code: 'INVALID_RECORD', jobId: '4' }
  const counts = { seen: 9, validRecords: 8, invalidRecords: 1 }
  const created = Date.now() - 1000
  const legacy = createImportDiagnostics(profile, '0.1.10', openPath)
  await legacy.report(job, counts, created)
  await legacy.open('4')
  const original = openPath.mock.lastCall![0]
  const first = await readFile(original, 'utf8')
  const app = appLogs()
  app.setDataArchives(data)
  const current = createImportDiagnostics(profile, '0.1.11', openPath, undefined, app)
  await current.report(job, counts, created)
  expect(await readdir(join(install, 'logs', 'import-errors'))).toEqual([])
  await current.open('4')
  expect(openPath.mock.lastCall![0]).toBe(original)
  expect(await readFile(original, 'utf8')).toBe(first)
  expect(JSON.parse(first)).toMatchObject({ version: '0.1.10', counts, recordedAt: expect.any(String) })
})

test('opens an enriched installation copy ahead of its original historical record', async () => {
  const { install, data, profile, openPath, appLogs } = await fixture()
  const old = join(data, 'logs')
  await mkdir(old)
  const legacy = createImportDiagnostics(old, '0.1.10', openPath)
  const job = { phase: 'parse', code: 'IMPORT_FAILED', jobId: '4' }
  const date = Date.now() - 1000
  await legacy.report(job, undefined, date)
  const [original] = await readdir(join(old, 'import-errors'))
  const logs = appLogs()
  logs.setDataArchives(data)
  const current = createImportDiagnostics(profile, 'new', openPath, undefined, logs)
  const counts = { seen: 9, validRecords: 8, invalidRecords: 1 }
  await current.report({ ...job, code: 'INVALID_RECORD' }, counts, date)
  await current.open('4')
  const file = join(install, 'logs', 'import-errors', original)
  expect(openPath.mock.lastCall![0]).toBe(file)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ counts, code: 'INVALID_RECORD', version: '0.1.10' })
})

test('preserves local failure categories and omits provider text and unknown codes', async () => {
  const { appLogs } = await fixture()
  const logs = appLogs()
  const location = await logs.open()
  const codes = ['INVALID_INSIGHT_OUTPUT', 'INVALID_INSIGHT_CHECKPOINT', 'CHATGPT_LIMIT', 'CHATGPT_ACCESS',
    'CHATGPT_UNAVAILABLE', 'CHATGPT_REQUEST', 'CHATGPT_INCOMPLETE', 'ACCOUNT_INCOMPLETE']
  for (const code of codes) await logs.record({ area: 'insight', phase: 'reading', error: new BoundaryError(code, 'fixture-private') })
  const records = await Promise.all((await readdir(location.path)).map(name => readFile(join(location.path, name), 'utf8')))
  expect(records.map(record => JSON.parse(record).code).sort()).toEqual(codes.sort())
  expect(records.join('')).not.toContain('fixture-private')
  await logs.record({ area: 'model', phase: 'generate', error: new BoundaryError('PRIVATE_UNKNOWN_CODE') })
  const all = await Promise.all((await readdir(location.path)).map(name => readFile(join(location.path, name), 'utf8')))
  expect(all.join('')).toContain('OPERATION_FAILED')
  expect(all.join('')).not.toContain('PRIVATE_UNKNOWN_CODE')
})
