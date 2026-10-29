import { afterEach, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createStagingService } from '../../electron/data/import/staging'

const roots: string[] = []
async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'whomi-discovery-')); roots.push(root)
  const source = join(root, 'source'); await fs.mkdir(source)
  return { root, source, service: createStagingService({ appDataDirectory: join(root, 'app') }), signal: new AbortController().signal }
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const fixture = (id: string, name = 'positive.json') => resolve('tests/fixtures/import', id, name)
it('discovers nested conversations, ignores media and unrelated manifests, exposes no paths or bodies', async () => {
  const { source, service, signal } = await setup()
  await fs.mkdir(join(source, 'nested'))
  await fs.copyFile(fixture('chatlab'), join(source, 'nested', 'chat.json'))
  await fs.writeFile(join(source, 'image.jpg'), 'image')
  await fs.writeFile(join(source, 'manifest.json'), '{"files":["nested/chat.json"]}')
  const result = await service.discover([{ rootPath: source }], signal)
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].formatId).toBe('chatlab')
  expect(JSON.stringify(result)).not.toContain(source)
  expect(JSON.stringify(result)).not.toContain('message 1')
})
it('deduplicates physical files through selected roots and declared wrapper dependencies', async () => {
  const { source, service, signal } = await setup()
  await fs.cp(resolve('tests/fixtures/import/qq-shuakami-chunked'), source, { recursive: true })
  await fs.rm(join(source, 'missing.json')); await fs.rm(join(source, 'corrupt.json'))
  const result = await service.discover([{ rootPath: source }, { rootPath: join(source, 'chunks', 'one.jsonl') }, { rootPath: join(source, 'positive.json') }], signal)
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].formatId).toBe('qq-shuakami-chunked')
})
it('blocks real Windows junction escape and loops before opening an outside file', async () => {
  const { root, source, signal } = await setup()
  const outside = join(root, 'outside'); await fs.mkdir(outside)
  await fs.copyFile(fixture('chatlab'), join(outside, 'secret.json'))
  await fs.symlink(outside, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.symlink(source, join(source, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
  let outsideReads = 0
  const service = createStagingService({ appDataDirectory: join(root, 'app'), access: { open: async (path, flags) => {
    if (String(path).includes('outside')) outsideReads++
    return fs.open(path, flags)
  } } })
  const result = await service.discover([{ rootPath: source }], signal)
  expect(result.issues.map(x => x.code)).toEqual(expect.arrayContaining(['PATH_ESCAPE', 'DIRECTORY_CYCLE']))
  expect(outsideReads).toBe(0)
  expect(result.entries).toHaveLength(0)
})
it('reports depth 17 and directory entry 10001 without silently claiming a complete scan', async () => {
  const { root, source, service, signal } = await setup()
  let folder = source
  for (let i = 0; i < 17; i++) { folder = join(folder, 'd'); await fs.mkdir(folder) }
  expect((await service.discover([{ rootPath: source }], signal)).issues.map(x => x.code)).toContain('DEPTH_LIMIT')
  const fake = createStagingService({ appDataDirectory: join(root, 'other'), access: {
    readdir: async () => Array.from({ length: 10001 }, (_, i) => `${i}.jpg`),
  } })
  expect((await fake.discover([{ rootPath: source }], signal)).issues.map(x => x.code)).toContain('ENTRY_LIMIT')
})
it('blocks traversal in a recognized chunk manifest and does not open its target', async () => {
  const { root, source, service, signal } = await setup()
  const raw = JSON.parse(await fs.readFile(fixture('qq-shuakami-chunked'), 'utf8'))
  raw.chunked.chunks[0].file = '../outside.jsonl'
  await fs.writeFile(join(source, 'manifest.json'), JSON.stringify(raw))
  await fs.writeFile(join(root, 'outside.jsonl'), 'private')
  expect((await service.discover([{ rootPath: source }], signal)).issues.map(x => x.code)).toContain('MANIFEST_PATH')
})
it('prepares extracted Google Takeout into the known manifest adapter', async () => {
  const { source, service, signal } = await setup()
  const base = join(source, 'Takeout', 'Google Chat')
  const group = join(base, 'Groups', 'Space synthetic'), user = join(base, 'Users', 'synthetic')
  await fs.mkdir(group, { recursive: true }); await fs.mkdir(user, { recursive: true })
  await fs.copyFile(fixture('google-chat-native', 'group.json'), join(group, 'group_info.json'))
  await fs.copyFile(fixture('google-chat-native', 'messages.json'), join(group, 'messages.json'))
  await fs.copyFile(fixture('google-chat-native', 'user.json'), join(user, 'user_info.json'))
  const result = await service.discover([{ rootPath: source }], signal)
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].formatId).toBe('google-chat-native')
  const staged = await service.stageInputs('test', result, signal)
  expect(staged.candidates[0].counts.validRecords).toBe(2)
  expect(staged.candidates[0].status).toBe('staged')
  await staged.cleanup()
})
it('enforces the 2 GiB stream threshold from file metadata before copying', async () => {
  const { root, source, signal } = await setup()
  const path = join(source, 'stream.jsonl')
  const fixtureBytes = await fs.readFile(fixture('chatlab-jsonl', 'positive.jsonl'))
  await fs.writeFile(path, Buffer.concat([fixtureBytes, Buffer.alloc(65536 - fixtureBytes.length, 32)]))
  let size = 2n * 1024n ** 3n
  const service = createStagingService({ appDataDirectory: join(root, 'stream-app'), access: {
    stat: async file => { const info = await fs.stat(file, { bigint: true }); if (info.isFile()) info.size = size; return info },
    open: async (file, flags) => { const handle = await fs.open(file, flags), stat = handle.stat.bind(handle); handle.stat = (async () => { const info = await stat({ bigint: true }); info.size = size; return info }) as typeof handle.stat; return handle },
  } })
  expect((await service.discover([{ rootPath: path }], signal)).entries).toHaveLength(1)
  size++
  const over = await service.discover([{ rootPath: path }], signal)
  expect(over.entries).toHaveLength(0)
  expect(over.issues.map(i => i.code)).toContain('FILE_LIMIT')
})
it('applies the 32 MiB bounded threshold to manifest and dependencies together', async () => {
  const { source, service, signal } = await setup()
  await fs.cp(resolve('tests/fixtures/import/google-chat-native'), source, { recursive: true })
  const manifest = join(source, 'positive.json')
  const paths = ['positive.json', 'user.json', 'group.json', 'messages.json'].map(name => join(source, name))
  const total = (await Promise.all(paths.map(path => fs.stat(path)))).reduce((n, info) => n + info.size, 0)
  await fs.appendFile(join(source, 'messages.json'), Buffer.alloc(32 * 1024 ** 2 - total, 32))
  expect((await service.discover([{ rootPath: manifest }], signal)).entries).toHaveLength(1)
  await fs.appendFile(join(source, 'messages.json'), ' ')
  const over = await service.discover([{ rootPath: manifest }], signal)
  expect(over.entries).toHaveLength(0)
  expect(over.issues.map(i => i.code)).toContain('FILE_LIMIT')
})
it('returns cancellation when an empty directory read is interrupted', async () => {
  const { root, source } = await setup(), controller = new AbortController()
  const service = createStagingService({ appDataDirectory: join(root, 'cancel-scan'), access: { readdir: async () => { controller.abort(); return [] } } })
  await expect(service.discover([{ rootPath: source }], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
})
it('applies the entry budget to direct multi-file grants before opening their contents', async () => {
  const { root, source, signal } = await setup()
  const path = join(source, 'one.json'); await fs.copyFile(fixture('chatlab'), path)
  let opened = 0
  const service = createStagingService({ appDataDirectory: join(root, 'multi-scan'), access: { open: async (file, flags) => { opened++; return fs.open(file, flags) } } })
  const result = await service.discover(Array.from({ length: 10001 }, () => ({ rootPath: path })), signal)
  expect(result.issues.map(i => i.code)).toContain('ENTRY_LIMIT')
  expect(opened).toBe(0)
}, 20000)
