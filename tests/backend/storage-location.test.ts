import { afterEach, describe, expect, it } from 'vitest'
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createStorageLocationService, resolveStorageLocation } from '../../electron/main/storage-location'

const temporaryDirectories: string[] = []
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'whomi-storage-location-'))
  temporaryDirectories.push(root)
  const source = join(root, 'user-data'), target = join(root, 'chosen-folder')
  await mkdir(source); await mkdir(target)
  const services = { running: true, resumed: '' }
  const service = createStorageLocationService({
    userDataPath: source,
    stopServices: async () => { services.running = false },
    resumeServices: async directory => { services.running = true; services.resumed = directory },
  })
  return { root, source, target, service, services }
}

async function seed(directory: string) {
  const session = join(directory, 'ai-runtime', 'sessions', 'test-model', 'conversation.jsonl')
  const staging = join(directory, 'import-staging', 'test-import')
  await mkdir(join(directory, 'ai-runtime', 'sessions', 'test-model'), { recursive: true })
  await mkdir(staging, { recursive: true })
  await writeFile(session, '{"type":"session","id":"example-session"}\n')
  await writeFile(join(staging, 'snapshot.json'), '{"messages":["示例消息"]}')
  const db = new Database(join(directory, 'whomi.db'))
  try {
    db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE ai_turns(id INTEGER PRIMARY KEY, checkpoint TEXT); CREATE TABLE ai_analysis_tasks(id INTEGER PRIMARY KEY, checkpoint TEXT); CREATE TABLE import_staging_areas(path TEXT PRIMARY KEY, app_directory TEXT, root TEXT, identity TEXT)')
    db.prepare('INSERT INTO conversations VALUES (?, ?)').run(1, '示例对话')
    const checkpoint = JSON.stringify({ sessionFile: session, leafId: 'example-leaf' })
    db.prepare('INSERT INTO ai_turns VALUES (?, ?)').run(1, checkpoint)
    db.prepare('INSERT INTO ai_analysis_tasks VALUES (?, ?)').run(1, checkpoint)
    const info = await stat(staging, { bigint: true })
    db.prepare('INSERT INTO import_staging_areas VALUES (?, ?, ?, ?)').run(staging, directory, join(directory, 'import-staging'), `${info.dev}:${info.ino}`)
  } finally { db.close() }
  return { session, staging }
}

describe('data location startup', () => {
  it('defaults to the existing user data directory without moving window or browser data', async () => {
    const { source, service } = await fixture()
    await writeFile(join(source, 'window-state.json'), '{"width":900}')
    expect(await resolveStorageLocation(source)).toBe(source)
    expect(await service.getStorage()).toEqual({ path: source, defaultPath: source, restartRequired: false })
    expect(await readdir(source)).toEqual(['window-state.json'])
  })

  it('rejects a corrupt or missing saved destination instead of opening an empty database', async () => {
    const { source, root } = await fixture()
    for (const pointer of ['broken json', JSON.stringify({ version: 1, path: 'relative' }), JSON.stringify({ version: 1, path: join(root, 'missing') })]) {
      await writeFile(join(source, 'storage-location.json'), pointer)
      await expect(resolveStorageLocation(source)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    }
  })

  it('rejects a saved destination whose database was truncated instead of initializing a blank library', async () => {
    const { source, target, service } = await fixture()
    await seed(source)
    const choice = await service.issueChoice(1, target)
    await service.relocateStorage(1, choice.token)
    await writeFile(join(target, 'whomi.db'), '')
    await expect(resolveStorageLocation(source)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(await readFile(join(source, 'whomi.db'))).not.toHaveLength(0)
  })
})

describe('data location authorization', () => {
  it('rejects the installation directory, its children and its ancestors before granting migration', async () => {
    const { root, source } = await fixture()
    const installation = join(root, 'applications', 'Whomi'), child = join(installation, 'data')
    await mkdir(child, { recursive: true })
    const service = createStorageLocationService({ userDataPath: source, blockedDirectories: [installation], stopServices: async () => {}, resumeServices: async () => {} })
    for (const destination of [child, installation, join(root, 'applications')]) {
      await expect(service.issueChoice(1, destination)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH', message: '请选择安装目录之外的空文件夹。' })
    }
    expect(await resolveStorageLocation(source)).toBe(source)
    expect(await readdir(child)).toEqual([])
  })

  it('migrates data to an external directory with a similar name to the installation', async () => {
    const { root, source } = await fixture()
    const installation = join(root, 'Whomi'), destination = join(root, 'Whomi-data')
    await mkdir(installation); await mkdir(destination)
    await seed(source)
    const service = createStorageLocationService({ userDataPath: source, blockedDirectories: [installation], stopServices: async () => {}, resumeServices: async () => {} })
    const choice = await service.issueChoice(1, destination)
    await service.relocateStorage(1, choice.token)
    expect(await resolveStorageLocation(source)).toBe(destination)
    const copied = new Database(join(destination, 'whomi.db'), { readonly: true })
    try { expect(copied.prepare('SELECT title FROM conversations').get()).toEqual({ title: '示例对话' }) } finally { copied.close() }
    expect(await readdir(installation)).toEqual([])
  })

  it('does not move data on selection and rejects forged or another window’s token', async () => {
    const { source, target, service, services } = await fixture()
    const choice = await service.issueChoice(1, target)
    expect(choice).toEqual({ token: expect.any(String), path: target })
    expect(await service.getStorage()).toMatchObject({ path: source, restartRequired: false })
    await expect(service.relocateStorage(2, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_CHOICE' })
    await expect(service.relocateStorage(1, target)).rejects.toMatchObject({ code: 'INVALID_STORAGE_CHOICE' })
    expect(services.running).toBe(true)
    expect(await readdir(target)).toEqual([])
  })

  it('revokes stale selections, closed windows and expired tokens', async () => {
    const { source, target } = await fixture()
    let now = 0
    const service = createStorageLocationService({ userDataPath: source, now: () => now, stopServices: async () => {}, resumeServices: async () => {} })
    const first = await service.issueChoice(1, target)
    const second = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, first.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_CHOICE' })
    service.revokeOwner(1)
    await expect(service.relocateStorage(1, second.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_CHOICE' })
    const expired = await service.issueChoice(1, target)
    now = 31 * 60 * 1000
    await expect(service.relocateStorage(1, expired.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_CHOICE' })
  })
})

describe('checked data relocation', () => {
  it('copies managed data, rebases checkpoints and switches future startups while preserving the original', async () => {
    const { source, target, service, services } = await fixture()
    const { session, staging } = await seed(source)
    const originalDb = await readFile(join(source, 'whomi.db'))
    await writeFile(join(source, 'window-state.json'), 'window preferences')
    await mkdir(join(source, 'Cache')); await writeFile(join(source, 'Cache', 'cache'), 'browser cache')
    await writeFile(join(source, 'unrelated.txt'), 'unrelated')
    const choice = await service.issueChoice(1, target)
    expect(await service.relocateStorage(1, choice.token)).toEqual({ path: target, defaultPath: source, restartRequired: true })
    expect(services.running).toBe(false)
    expect(await resolveStorageLocation(source)).toBe(target)
    expect(await service.getStorage()).toMatchObject({ path: target, restartRequired: true })
    expect(await readdir(target)).toEqual(['ai-runtime', 'import-staging', 'whomi.db'])
    expect(await readFile(join(source, 'whomi.db'))).toEqual(originalDb)
    expect(await readFile(session, 'utf8')).toContain('example-session')
    expect(await readFile(join(staging, 'snapshot.json'), 'utf8')).toContain('示例消息')
    expect(await readFile(join(target, 'ai-runtime', 'sessions', 'test-model', 'conversation.jsonl'))).toEqual(await readFile(session))
    expect(await readFile(join(target, 'import-staging', 'test-import', 'snapshot.json'))).toEqual(await readFile(join(staging, 'snapshot.json')))
    const db = new Database(join(target, 'whomi.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT title FROM conversations').get()).toEqual({ title: '示例对话' })
      for (const table of ['ai_turns', 'ai_analysis_tasks']) {
        const row = db.prepare(`SELECT checkpoint FROM ${table}`).get() as { checkpoint: string }
        expect(JSON.parse(row.checkpoint)).toEqual({ sessionFile: join(target, 'ai-runtime', 'sessions', 'test-model', 'conversation.jsonl'), leafId: 'example-leaf' })
      }
      const info = await stat(join(target, 'import-staging', 'test-import'), { bigint: true })
      expect(db.prepare('SELECT * FROM import_staging_areas').get()).toEqual({ path: join(target, 'import-staging', 'test-import'), app_directory: target, root: join(target, 'import-staging'), identity: `${info.dev}:${info.ino}` })
    } finally { db.close() }
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_RESTART_REQUIRED' })
  })

  it('copies the final committed data after services stop and includes writes from a SQLite journal', async () => {
    const { source, target } = await fixture()
    await seed(source)
    const db = new Database(join(source, 'whomi.db'))
    db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0')
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { db.prepare('UPDATE conversations SET title=?').run('最终保存结果') }, resumeServices: async () => {} })
    try {
      const choice = await service.issueChoice(1, target)
      await service.relocateStorage(1, choice.token)
      const copied = new Database(join(target, 'whomi.db'), { readonly: true })
      try { expect(copied.prepare('SELECT title FROM conversations').get()).toEqual({ title: '最终保存结果' }) } finally { copied.close() }
    } finally { db.close() }
  })

  it('preserves the processing version while relocating the wrapped runtime checkpoint', async () => {
    const { source, target, service } = await fixture()
    const { session } = await seed(source)
    const original = JSON.stringify({ processing: 'example-settings-version', checkpoint: JSON.stringify({ sessionFile: session, leafId: 'example-leaf' }) })
    const db = new Database(join(source, 'whomi.db'))
    try { db.prepare('UPDATE ai_turns SET checkpoint=?').run(original) } finally { db.close() }
    const choice = await service.issueChoice(1, target)
    await service.relocateStorage(1, choice.token)
    const copied = new Database(join(target, 'whomi.db'), { readonly: true })
    try {
      const row = copied.prepare('SELECT checkpoint FROM ai_turns').get() as { checkpoint: string }
      const wrapped = JSON.parse(row.checkpoint)
      expect(wrapped.processing).toBe('example-settings-version')
      expect(JSON.parse(wrapped.checkpoint)).toEqual({ sessionFile: join(target, 'ai-runtime', 'sessions', 'test-model', 'conversation.jsonl'), leafId: 'example-leaf' })
    } finally { copied.close() }
  })

  it('uses the fixed user data pointer when migrating a custom directory again', async () => {
    const { root, source, target, service } = await fixture()
    await seed(source)
    const choice = await service.issueChoice(1, target)
    await service.relocateStorage(1, choice.token)
    const secondTarget = join(root, 'second-target'); await mkdir(secondTarget)
    const resumed = createStorageLocationService({ userDataPath: source, stopServices: async () => {}, resumeServices: async () => {} })
    expect(await resumed.getStorage()).toEqual({ path: target, defaultPath: source, restartRequired: false })
    const second = await resumed.issueChoice(1, secondTarget)
    await resumed.relocateStorage(1, second.token)
    expect(await resolveStorageLocation(source)).toBe(secondTarget)
    expect(await readdir(target)).not.toContain('storage-location.json')
    const copied = new Database(join(secondTarget, 'whomi.db'), { readonly: true })
    try {
      const row = copied.prepare('SELECT checkpoint FROM ai_turns').get() as { checkpoint: string }
      expect(JSON.parse(row.checkpoint).sessionFile).toBe(join(secondTarget, 'ai-runtime', 'sessions', 'test-model', 'conversation.jsonl'))
    } finally { copied.close() }
  })

  it('refuses to create an empty database if the saved destination loses its database', async () => {
    const { root, source, target, service } = await fixture()
    await seed(source)
    const choice = await service.issueChoice(1, target)
    await service.relocateStorage(1, choice.token)
    await rename(join(target, 'whomi.db'), join(root, 'temporarily-unavailable.db'))
    await expect(resolveStorageLocation(source)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(await readdir(target)).not.toContain('whomi.db')
  })

  it('never follows a source hard link to data outside the managed directory', async () => {
    const { root, source, target, service } = await fixture()
    const outside = join(root, 'outside-file')
    await writeFile(outside, 'external data')
    await mkdir(join(source, 'ai-runtime'))
    await link(outside, join(source, 'ai-runtime', 'external'))
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    expect(await readFile(outside, 'utf8')).toBe('external data')
    expect(await readdir(target)).toEqual([])
  })

  it('restores a partial service shutdown without copying data when stop fails', async () => {
    const { source, target } = await fixture()
    await seed(source)
    let resumed = ''
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { throw new Error('service shutdown failed') }, resumeServices: async path => { resumed = path } })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' })
    expect(resumed).toBe(source)
    expect(await readdir(target)).toEqual([])
    expect(await resolveStorageLocation(source)).toBe(source)
  })

  it('retries a failed migration with the same choice after services recover', async () => {
    const { source, target } = await fixture()
    await seed(source)
    let stopAttempts = 0
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { if (++stopAttempts === 1) throw new Error('temporary shutdown failure') }, resumeServices: async () => {} })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' })
    expect(await service.relocateStorage(1, choice.token)).toMatchObject({ path: target, restartRequired: true })
    expect(await resolveStorageLocation(source)).toBe(target)
  })

  it('rechecks the identity and emptiness of a retained choice before retrying', async () => {
    const { root, source, target } = await fixture()
    await seed(source)
    let stopAttempts = 0
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { stopAttempts++; throw new Error('temporary shutdown failure') }, resumeServices: async () => {} })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' })
    await writeFile(join(target, 'user-file.txt'), 'keep me')
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    await rename(target, join(root, 'original-target')); await mkdir(target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    expect(stopAttempts).toBe(1)
    expect(await readFile(join(root, 'original-target', 'user-file.txt'), 'utf8')).toBe('keep me')
    expect(await resolveStorageLocation(source)).toBe(source)
  })

  it('requires a restart when restoring services fails after an unsuccessful migration', async () => {
    const { source, target } = await fixture()
    await writeFile(join(source, 'whomi.db'), 'damaged database')
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => {}, resumeServices: async () => { throw new Error('restart failed') } })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_RESTORE_FAILED' })
    expect(await service.getStorage()).toEqual({ path: source, defaultPath: source, restartRequired: true })
    expect(await resolveStorageLocation(source)).toBe(source)
  })

  it('rejects nonempty, same, descendant, ancestor and relative destinations before stopping services', async () => {
    const { root, source, target, service, services } = await fixture()
    await writeFile(join(target, 'user-file.txt'), 'keep me')
    const child = join(source, 'nested'); await mkdir(child)
    for (const path of [target, source, child, root, 'relative-folder']) {
      await expect(service.issueChoice(1, path)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    }
    expect(services.running).toBe(true)
    expect(await readFile(join(target, 'user-file.txt'), 'utf8')).toBe('keep me')
  })

  it('rejects a destination junction and a junction in its parent path', async () => {
    const { root, target, service } = await fixture()
    const link = join(root, 'link')
    await symlink(target, link, 'junction')
    await mkdir(join(target, 'child'))
    for (const path of [link, join(link, 'child')]) await expect(service.issueChoice(1, path)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
  })

  it('rechecks a chosen destination after stopping and keeps unrelated files untouched', async () => {
    const { source, target } = await fixture()
    await seed(source)
    let resumed = ''
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { await writeFile(join(target, 'user-file.txt'), 'keep me') }, resumeServices: async path => { resumed = path } })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    expect(await resolveStorageLocation(source)).toBe(source)
    expect(await readdir(target)).toEqual(['user-file.txt'])
    expect(resumed).toBe(source)
  })

  it('rejects source links without following or changing their external files', async () => {
    const { root, source, target, service, services } = await fixture()
    await seed(source)
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'keep outside')
    await symlink(outside, join(source, 'ai-runtime', 'linked'), 'junction')
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    expect(await resolveStorageLocation(source)).toBe(source)
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('keep outside')
    expect(services.resumed).toBe(source)
  })

  it('restores services and the prior pointer when validating a copied database fails', async () => {
    const { source, target, service, services } = await fixture()
    await writeFile(join(source, 'whomi.db'), 'damaged database')
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' })
    expect(await resolveStorageLocation(source)).toBe(source)
    expect(await readFile(join(source, 'whomi.db'), 'utf8')).toBe('damaged database')
    expect(await readdir(target)).toEqual([])
    expect(services.resumed).toBe(source)
  })

  it('does not publish a partial destination when saving the pointer fails', async () => {
    const { source, target } = await fixture()
    await seed(source)
    let resumed = ''
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { await mkdir(join(source, 'storage-location.json')) }, resumeServices: async path => { resumed = path } })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' })
    expect(resumed).toBe(source)
    expect(await readdir(target)).toEqual([])
  })

  it('rejects a replaced destination directory even when its replacement is empty', async () => {
    const { root, source, target } = await fixture()
    await seed(source)
    let resumed = ''
    const service = createStorageLocationService({ userDataPath: source, stopServices: async () => { await rename(target, join(root, 'original-target')); await mkdir(target) }, resumeServices: async path => { resumed = path } })
    const choice = await service.issueChoice(1, target)
    await expect(service.relocateStorage(1, choice.token)).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' })
    expect(await readdir(target)).toEqual([])
    expect(resumed).toBe(source)
  })

  it('blocks concurrent migrations before either operation can stop services twice', async () => {
    const { root, source, target } = await fixture()
    const other = join(root, 'other'); await mkdir(other)
    let release!: () => void
    const stopped = new Promise<void>(resolve => { release = resolve })
    const service = createStorageLocationService({ userDataPath: source, stopServices: () => stopped, resumeServices: async () => {} })
    const one = await service.issueChoice(1, target), two = await service.issueChoice(2, other)
    const first = service.relocateStorage(1, one.token)
    await expect(service.relocateStorage(2, two.token)).rejects.toMatchObject({ code: 'STORAGE_BUSY' })
    release()
    expect(await first).toMatchObject({ path: target, restartRequired: true })
    expect(await readdir(other)).toEqual([])
  })
})
