import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createImportDiagnostics } from '../../electron/main/import-diagnostics'
import { createDataService } from '../../electron/data/service'
import { openStore } from '../../electron/data/db/open'

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

test('revisiting a failed job after restart opens its original file and counts', async () => {
  const { root, opened, diagnostics } = await setup()
  const first = diagnostics()
  const failure = { jobId: '1', phase: 'parse', code: 'INVALID_RECORD' }
  await first.report(failure, { seen: 5, validRecords: 4, invalidRecords: 1 })
  await first.open('1')
  const originalPath = opened.mock.lastCall![0]
  const original = await readFile(originalPath, 'utf8')

  const restarted = diagnostics()
  await restarted.report(failure)
  await restarted.open('1')
  expect(opened.mock.lastCall![0]).toBe(originalPath)
  expect(await readFile(originalPath, 'utf8')).toBe(original)
  await restarted.report({ jobId: '1', phase: 'cancel', code: 'CANCEL_FAILED' })
  await restarted.open('1')
  expect(JSON.parse(await readFile(opened.mock.lastCall![0], 'utf8')).code).toBe('CANCEL_FAILED')
  expect(await readdir(join(root, 'import-errors'))).toHaveLength(2)
})

test.each([
  ['invalid-record', 'INVALID_RECORD'],
  ['invalid-header', 'INVALID_HEADER'],
  ['missing-messages', 'MISSING_MESSAGES'],
  ['STAGING_CLOSED', 'STAGING_CLOSED'],
  ['PREVIEW_UNAVAILABLE', 'PREVIEW_UNAVAILABLE'],
  ['INVALID_PAGE', 'INVALID_PAGE'],
  ['unknown-sender', 'IMPORT_FAILED'],
  ['FORMAT_PRIORITY_SELECTED', 'IMPORT_FAILED'],
  ['unrecognized-private-detail', 'IMPORT_FAILED'],
])('writes only an allowlisted blocking diagnostic for %s', async (code, expected) => {
  const { opened, diagnostics } = await setup()
  const log = diagnostics()
  await log.report({ phase: 'parse', code, jobId: '1' })
  await log.open('1')
  expect(JSON.parse(await readFile(opened.mock.lastCall![0], 'utf8')).code).toBe(expected)
})

test('a renderer report arriving first uses the stored failure and counts', async () => {
  const { root, opened } = await setup()
  const counts = { seen: 5, validRecords: 4, invalidRecords: 1 }
  const stored = {
    jobId: '1', status: 'failed' as const, failurePhase: 'parse' as const, counts,
    issues: [{ code: 'invalid-record', severity: 'blocking' as const, action: '请核对文件。', candidateId: 'example', ordinal: 1 }],
    discovery: null, candidates: [], results: [], inserted: 0, duplicates: 0,
  }
  const log = createImportDiagnostics(root, '1.2.3', opened, async () => stored)
  await log.report({ jobId: '1', phase: 'parse', code: 'STAGING_FAILED' })
  await log.open('1')
  expect(JSON.parse(await readFile(opened.mock.lastCall![0], 'utf8'))).toMatchObject({ code: 'INVALID_RECORD', counts })
  await log.report({ jobId: '1', phase: 'parse', code: 'invalid-record' }, counts)
  expect(await readdir(join(root, 'import-errors'))).toHaveLength(1)
})

test('fills in counts received after an initial report without replacing its time or path', async () => {
  const { opened, diagnostics } = await setup()
  const log = diagnostics()
  const failure = { jobId: '1', phase: 'save', code: 'COMMIT_FAILED' }
  await log.report(failure)
  await log.open('1')
  const path = opened.mock.lastCall![0]
  const original = JSON.parse(await readFile(path, 'utf8'))
  const counts = { seen: 6, validRecords: 6, invalidRecords: 0 }
  await log.report(failure, counts)
  await log.open('1')
  expect(opened.mock.lastCall![0]).toBe(path)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...original, counts })
})

test('restores the counted original when an older installation already made a sparse duplicate', async () => {
  const { root, opened, diagnostics } = await setup()
  const first = diagnostics()
  const counts = { seen: 5, validRecords: 4, invalidRecords: 1 }
  await first.report({ phase: 'parse', code: 'IMPORT_FAILED', jobId: '1' }, counts)
  await first.open('1')
  const path = opened.mock.lastCall![0]
  const original = JSON.parse(await readFile(path, 'utf8'))
  const later = new Date(Date.parse(original.recordedAt) + 1)
  const duplicate = join(root, 'import-errors', `${later.getTime()}-00000000-0000-4000-8000-000000000001-1.txt`)
  await writeFile(duplicate, JSON.stringify({ version: original.version, recordedAt: later.toISOString(), phase: 'parse', code: 'IMPORT_FAILED' }))
  const restarted = diagnostics()
  await restarted.report({ phase: 'parse', code: 'invalid-record', jobId: '1' }, counts)
  await restarted.open('1')
  expect(opened.mock.lastCall![0]).toBe(path)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...original, code: 'INVALID_RECORD' })
  expect(await readdir(join(root, 'import-errors'))).toHaveLength(2)
  await diagnostics().open()
  expect(opened.mock.lastCall![0]).toBe(path)
})

test('an old duplicate does not displace a later independent failure from Settings', async () => {
  const { root, opened, diagnostics } = await setup()
  const log = diagnostics()
  await log.report({ phase: 'parse', code: 'IMPORT_FAILED', jobId: '1' }, { seen: 1, validRecords: 0, invalidRecords: 1 })
  await log.report({ phase: 'source', code: 'PICKER_FAILED' })
  await log.open(null)
  const laterFailure = opened.mock.lastCall![0]
  const later = new Date(Date.parse(JSON.parse(await readFile(laterFailure, 'utf8')).recordedAt) + 1)
  await writeFile(join(root, 'import-errors', `${later.getTime()}-00000000-0000-4000-8000-000000000001-1.txt`),
    JSON.stringify({ version: '1.2.3', recordedAt: later.toISOString(), phase: 'parse', code: 'IMPORT_FAILED' }))
  await diagnostics().open()
  expect(opened.mock.lastCall![0]).toBe(laterFailure)
})

test.each([undefined, '1'])('opens the later counted legacy failure for job filter %s', async jobId => {
  const { root, opened, diagnostics } = await setup()
  const directory = join(root, 'import-errors')
  await mkdir(directory)
  const firstTime = Date.UTC(2026, 0, 1)
  async function writeLegacy(offset: number, seen?: number) {
    const time = firstTime + offset
    const filename = join(directory, `${time}-00000000-0000-4000-8000-000000000001-1.txt`)
    await writeFile(filename, JSON.stringify({ recordedAt: new Date(time).toISOString(), version: '1.2.3', phase: 'parse', code: 'IMPORT_FAILED',
      ...(seen === undefined ? {} : { counts: { seen, validRecords: seen - 1, invalidRecords: 1 } }) }))
    return filename
  }
  await writeLegacy(0, 5)
  const latestFailure = await writeLegacy(1, 12)
  await diagnostics().open(jobId)
  expect(opened.mock.lastCall![0]).toBe(latestFailure)
  await writeLegacy(2)
  await diagnostics().open(jobId)
  expect(opened.mock.lastCall![0]).toBe(latestFailure)
})

test('an incomplete Google Takeout archive keeps the blocking scanner code in its diagnostic', async () => {
  const { root, opened } = await setup()
  const group = join(root, 'Takeout', 'Google Chat', 'Groups', 'DM example')
  await mkdir(group, { recursive: true })
  await writeFile(join(group, 'group_info.json'), '{}')
  const store = openStore(join(root, 'whomi.db'))
  const service = createDataService({ store, appDataDirectory: root })
  try {
    const id = await service.prepareImport([{ rootPath: join(root, 'Takeout') }])
    const log = createImportDiagnostics(root, '1.2.3', opened, service.getImport)
    await log.report({ jobId: id, phase: 'scan', code: 'DISCOVERY_FAILED' })
    await log.open(id)
    expect(JSON.parse(await readFile(opened.mock.lastCall![0], 'utf8')).code).toBe('TAKEOUT_INCOMPLETE')
  } finally { await service.idle(); store.close() }
})

test.each(['current', 'legacy'])('separate libraries distinguish job 1 when the first log uses the %s filename', async format => {
  const { root, opened } = await setup()
  const failure = { jobId: '1', phase: 'parse' as const, code: 'INVALID_RECORD' }
  const start = Date.now() - 10_000
  let legacyPath: string | undefined
  if (format === 'legacy') {
    const directory = join(root, 'import-errors')
    await mkdir(directory)
    legacyPath = join(directory, `${start + 100}-00000000-0000-4000-8000-000000000001-1.txt`)
    await writeFile(legacyPath, JSON.stringify({ version: '1.2.3', recordedAt: new Date(start + 100).toISOString(),
      phase: 'parse', code: 'IMPORT_FAILED', counts: { seen: 5, validRecords: 4, invalidRecords: 1 } }))
  }
  async function writeFromDatabase(library: string, jobCreatedAt: number, seen: number) {
    const store = openStore(join(root, library))
    store.writer.prepare("INSERT OR IGNORE INTO import_jobs(id,status,phase,created_at_ms,metadata) VALUES(1,'failed','failed',?,?)")
      .run(jobCreatedAt, JSON.stringify({ failurePhase: 'parse', counts: { seen, validRecords: seen - 1, invalidRecords: 1 },
        issues: [{ severity: 'blocking', candidateId: '', action: '请核对文件。', code: 'invalid-record' }] }))
    const service = createDataService({ store, appDataDirectory: root })
    try {
      const log = createImportDiagnostics(root, '1.2.3', opened, service.getImport)
      await log.report(failure)
      await log.open('1')
      const path = opened.mock.lastCall![0]
      expect(JSON.parse(await readFile(path, 'utf8')).counts.seen).toBe(seen)
      return path
    } finally { await service.idle(); store.close() }
  }
  const original = await writeFromDatabase('first.db', start, 5)
  if (legacyPath) expect(original).toBe(legacyPath)
  const other = await writeFromDatabase('restored.db', start + 50, 12)
  expect(other).not.toBe(original)
  expect(await writeFromDatabase('first.db', start, 5)).toBe(original)
  expect(await readdir(join(root, 'import-errors'))).toHaveLength(2)
})
