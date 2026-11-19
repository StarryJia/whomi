import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createImportDiagnostics } from '../../electron/main/import-diagnostics'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'whomi-import-diagnostics-'))
  roots.push(root)
  const opened = vi.fn(async (_path: string) => '')
  const diagnostics = () => createImportDiagnostics(root, '1.2.3', opened)
  return { root, opened, diagnostics }
}

test('opens a batch diagnostic after restart and keeps the file free of source information', async () => {
  const { root, opened, diagnostics } = await setup()
  const log = diagnostics()
  await log.report({ phase: 'statistics', code: 'STATISTICS_FAILED', jobId: '1' }, { seen: 120, validRecords: 120, invalidRecords: 0 })
  await log.report({ phase: 'statistics', code: 'STATISTICS_FAILED', jobId: '1' })
  await log.report({ phase: 'parse', code: 'C:\\Users\\Alice\\private-export.json CHATBODY', jobId: '2' })

  await diagnostics().open('1')
  const openedPath = opened.mock.calls[0][0]
  expect(JSON.parse(await readFile(openedPath, 'utf8'))).toEqual({
    recordedAt: expect.any(String), version: '1.2.3', phase: 'statistics', code: 'STATISTICS_FAILED',
    counts: { seen: 120, validRecords: 120, invalidRecords: 0 },
  })
  const filenames = await readdir(join(root, 'import-errors'))
  expect(filenames).toHaveLength(2)
  const second = filenames.find(name => name.endsWith('-2.txt'))!
  expect(await readFile(join(root, 'import-errors', second), 'utf8')).not.toMatch(/private-export|CHATBODY|Alice/)
  await diagnostics().open()
  expect(opened.mock.lastCall![0]).toBe(join(root, 'import-errors', second))
  await expect(diagnostics().open(null)).rejects.toMatchObject({ code: 'IMPORT_LOG_MISSING' })
  await log.report({ phase: 'source', code: 'PICKER_FAILED' })
  await diagnostics().open(null)
  expect(opened.mock.lastCall![0]).toMatch(/-none\.txt$/)
})

test('distinguishes missing logs, native open failures and unwritable storage', async () => {
  const { root, opened, diagnostics } = await setup()
  const log = diagnostics()
  await expect(log.open('1')).rejects.toMatchObject({ code: 'IMPORT_LOG_MISSING' })
  await expect(log.open('..\\private.txt')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await log.report({ phase: 'source', code: 'INVALID_SOURCE' })
  opened.mockResolvedValueOnce('OS failure')
  await expect(log.open()).rejects.toMatchObject({ code: 'IMPORT_LOG_OPEN_FAILED' })
  const invalidRoot = join(root, 'not-a-directory')
  await writeFile(invalidRoot, '')
  await expect(createImportDiagnostics(invalidRoot, '1.2.3', opened).report({ phase: 'save', code: 'OPERATION_FAILED' }))
    .rejects.toMatchObject({ code: 'IMPORT_LOG_WRITE_FAILED' })
})
