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
  expect(result.fileCount).toBe(3)
  const sizes = await Promise.all(['nested/chat.json', 'image.jpg', 'manifest.json'].map(name => fs.stat(join(source, name))))
  expect(result.totalBytes).toBe(sizes.reduce((sum, item) => sum + item.size, 0))
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].formatId).toBe('chatlab')
  expect(JSON.stringify(result)).not.toContain(source)
  expect(JSON.stringify(result)).not.toContain('message 1')
})
it.runIf(process.platform === 'win32')('distinguishes identical export paths across selected Windows drives and shares', async () => {
  const { root, source, signal } = await setup()
  const selections = ['D:\\聊天备份\\result.json', 'E:\\聊天备份\\result.json',
    '\\\\资料机\\备份甲\\聊天备份\\result.json', '\\\\资料机\\备份乙\\聊天备份\\result.json']
  // 将虚构的卷和共享映射到各自的本机样本，无需访问网络或额外磁盘。
  const local = new Map<string, string>()
  for (const [index, path] of selections.entries()) {
    const sample = join(source, index + '.json')
    await fs.copyFile(fixture('telegram-native-single'), sample)
    local.set(path, sample)
  }
  const service = createStagingService({ appDataDirectory: join(root, 'app'), access: {
    realpath: async path => path,
    stat: path => fs.stat(local.get(path)!, { bigint: true }),
    open: (path, flags) => fs.open(local.get(path)!, flags),
  } })
  const discovery = await service.discover(selections.map(rootPath => ({ rootPath })), signal)
  const names = discovery.entries.map(entry => entry.displayName)
  expect(new Set(names).size).toBe(4)
  for (const label of ['D 盘', 'E 盘', '备份甲', '备份乙']) expect(names.some(name => name.includes(label))).toBe(true)
  expect(names.every(name => !name.includes('\\') && !name.includes('聊天备份'))).toBe(true)
})
it.each(['folder', 'files'])('identifies same-named exports with the shortest distinguishing folders from selected %s', async selection => {
  const { source, service, signal } = await setup()
  const example = JSON.parse(await fs.readFile(fixture('telegram-native-single'), 'utf8'))
  const folders = ['十月', '十一月', '归档/甲/导出', '归档/乙/导出']
  const paths: string[] = []
  for (const [index, folder] of folders.entries()) {
    const directory = join(source, folder)
    await fs.mkdir(directory, { recursive: true })
    const path = join(directory, 'result.json')
    await fs.writeFile(path, JSON.stringify({ ...example, id: 330 + index, name: '项目组' }))
    paths.push(path)
  }
  const unique = join(source, '归档', '独立.json')
  await fs.copyFile(fixture('chatlab'), unique)
  paths.push(unique)
  const discovery = await service.discover((selection === 'folder' ? [source] : paths).map(rootPath => ({ rootPath })), signal)
  expect(discovery.entries.map(entry => entry.displayName).sort()).toEqual(
    ['十月/result.json', '十一月/result.json', '甲/导出/result.json', '乙/导出/result.json', '独立.json'].sort(),
  )
  const november = discovery.entries.find(entry => entry.displayName === '十一月/result.json')!
  const onlyNovember = service.selectDiscovery(discovery, [november.entryId])
  expect(onlyNovember.entries).toEqual([november])
  const staged = await service.stageInputs('1', onlyNovember, signal)
  try {
    expect(staged.candidates).toMatchObject([{ entryId: november.entryId, title: '项目组', identity: { conversationKey: '331' } }])
  } finally { await staged.cleanup() }
})
it('keeps the shorter relative location recognizable when a backup repeats its whole folder name', async () => {
  const { source, service, signal } = await setup()
  for (const folder of ['十月', '归档/十月']) {
    const directory = join(source, folder)
    await fs.mkdir(directory, { recursive: true })
    await fs.copyFile(fixture('chatlab'), join(directory, 'result.json'))
  }
  const discovery = await service.discover([{ rootPath: source }], signal)
  expect(discovery.entries.map(entry => entry.displayName).sort()).toEqual(['十月/result.json', '归档/十月/result.json'].sort())
})
it('deduplicates physical files through selected roots and declared wrapper dependencies', async () => {
  const { source, service, signal } = await setup()
  await fs.cp(resolve('tests/fixtures/import/qq-shuakami-chunked'), source, { recursive: true })
  await fs.rm(join(source, 'missing.json')); await fs.rm(join(source, 'corrupt.json'))
  const result = await service.discover([{ rootPath: source }, { rootPath: join(source, 'chunks', 'one.jsonl') }, { rootPath: join(source, 'positive.json') }], signal)
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].formatId).toBe('qq-shuakami-chunked')
})
it.each(['declared-count', 'conversation-header'])('preserves distinct manifests sharing chunks when their %s differs', async difference => {
  const { source, service, signal } = await setup()
  await fs.cp(resolve('tests/fixtures/import/qq-shuakami-chunked/chunks'), join(source, 'chunks'), { recursive: true })
  const manifest = JSON.parse(await fs.readFile(fixture('qq-shuakami-chunked'), 'utf8'))
  await fs.writeFile(join(source, 'first.json'), JSON.stringify(manifest))
  if (difference === 'declared-count') manifest.statistics.totalMessages = 99
  else manifest.chatInfo.name = 'Another synthetic conversation'
  await fs.writeFile(join(source, 'second.json'), JSON.stringify(manifest))
  const result = await service.discover([{ rootPath: source }, { rootPath: join(source, 'first.json') }, { rootPath: join(source, 'chunks', 'one.jsonl') }], signal)
  expect(result.entries.map(entry => entry.displayName)).toEqual(['first.json', 'second.json'])
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
