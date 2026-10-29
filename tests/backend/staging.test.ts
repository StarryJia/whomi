import { afterEach, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createStagingService } from '../../electron/data/import/staging'
import { openStore } from '../../electron/data/db/open'
import { getParsers } from '../../electron/data/parsers/registry'
import { collect, parseSynthetic } from './parser-helpers'
import type { ParserAdapter } from '../../electron/data/parsers/types'
import type { ParsedMessage } from '../../src/shared/conversation-model'
import { withSnapshot } from '../../electron/data/parsers/snapshot-fs'
import { lines } from '../../electron/data/parsers/input'

const roots: string[] = []
async function setup(id = 'chatlab') {
  const root = await fs.mkdtemp(join(tmpdir(), 'whomi-staging-')); roots.push(root)
  const source = join(root, 'source'); await fs.mkdir(source)
  await fs.copyFile(resolve('tests/fixtures/import', id, 'positive.json'), join(source, 'chat.json'))
  const service = createStagingService({ appDataDirectory: join(root, 'app') })
  return { root, source, service, signal: new AbortController().signal }
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
it('stages into a private SQLite view with counts, origins, member candidates and bounded pages without formal writes', async () => {
  const { root, source, service, signal } = await setup()
  const formal = openStore(join(root, 'formal.sqlite'))
  try {
    const discovery = await service.discover([{ rootPath: source }], signal)
    const stage = await service.stageInputs('test', discovery, signal)
    expect(stage.candidates).toHaveLength(1)
    const candidate = stage.candidates[0]
    expect(candidate.status).toBe('staged')
    expect(candidate.counts).toEqual({ seen: 2, validRecords: 2, invalidRecords: 0 })
    expect(candidate.members.length).toBeGreaterThan(0)
    expect(candidate.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(stage.preview(candidate.candidateId, { limit: 1 }).messages).toHaveLength(1)
    const group = stage.conversation([candidate.candidateId])
    expect([...group.messages()].map(m => m.origin.ordinal)).toEqual([0, 1])
    expect(group.candidateIds).toEqual([candidate.candidateId])
    expect(formal.reader.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0n })
    expect(() => stage.preview(candidate.candidateId, { limit: 51 })).toThrow()
    await stage.cleanup()
    await expect(fs.stat(stage.path)).rejects.toThrow()
  } finally { formal.close() }
})
it('uses selected entry IDs and rejects forged discovery and unknown selections', async () => {
  const { source, service, signal } = await setup()
  await fs.copyFile(resolve('tests/fixtures/import/echotrace/positive.json'), join(source, 'other.json'))
  const discovery = await service.discover([{ rootPath: source }], signal)
  expect(() => service.selectDiscovery(discovery, ['forged'])).toThrow()
  await expect(service.stageInputs('bad', { ...discovery }, signal)).rejects.toThrow()
  const selected = service.selectDiscovery(discovery, [discovery.entries[0].entryId])
  const stage = await service.stageInputs('test', selected, signal)
  expect(stage.candidates).toHaveLength(1)
  await stage.cleanup()
})
it('blocks source changes after discovery while continuing independent files', async () => {
  const { source, service, signal } = await setup()
  await fs.copyFile(resolve('tests/fixtures/import/echotrace/positive.json'), join(source, 'other.json'))
  const discovery = await service.discover([{ rootPath: source }], signal)
  await fs.appendFile(join(source, 'chat.json'), ' ')
  const staged = await service.stageInputs('test', discovery, signal)
  expect(staged.issues.map(x => x.code)).toContain('SOURCE_CHANGED')
  expect(staged.candidates.some(x => x.status === 'staged')).toBe(true)
  expect(staged.candidates.some(x => x.status === 'blocked')).toBe(true)
  await staged.cleanup()
})
it('detects same-length in-place source mutations during copying', async () => {
  const { root, source, signal } = await setup()
  let mutate = false
  const service = createStagingService({ appDataDirectory: join(root, 'race-app'), access: { open: async (path, flags) => {
    const handle = await fs.open(path, flags)
    if (mutate && path === join(source, 'chat.json')) {
      const read = handle.read.bind(handle)
      handle.read = (async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args)
        if (mutate) { mutate = false; const bytes = await fs.readFile(path); bytes[bytes.length - 2] = 32; await fs.writeFile(path, bytes) }
        return result
      }) as typeof handle.read
    }
    return handle
  } } })
  const discovery = await service.discover([{ rootPath: source }], signal)
  mutate = true
  const stage = await service.stageInputs('test', discovery, signal)
  expect(stage.issues.map(x => x.code)).toContain('SOURCE_CHANGED')
  expect(stage.candidates.every(x => x.status === 'blocked')).toBe(true)
  await stage.cleanup()
})
it('blocks mismatched declared message counts and malformed UTF8 without leaking body or original paths', async () => {
  const { source, service, signal } = await setup('echotrace')
  const path = join(source, 'chat.json'), raw = JSON.parse(await fs.readFile(path, 'utf8'))
  raw.session.messageCount = 99
  await fs.writeFile(path, JSON.stringify(raw))
  const stage = await service.stageInputs('test', await service.discover([{ rootPath: source }], signal), signal)
  expect(stage.issues.map(x => x.code)).toContain('DECLARED_COUNT_MISMATCH')
  expect(stage.candidates[0].status).toBe('blocked')
  expect(JSON.stringify(stage.issues)).not.toContain(source)
  await stage.cleanup()
  const bytes = Buffer.from(JSON.stringify(raw)); const index = bytes.indexOf(Buffer.from('SIWX')); bytes[index] = 0xff
  await fs.writeFile(path, bytes)
  const bad = await service.stageInputs('test', await service.discover([{ rootPath: source }], signal), signal)
  expect(bad.candidates[0].status).toBe('blocked')
  await bad.cleanup()
})
it('emits declared header counts only where they represent messages', async () => {
  expect((await collect('echotrace', 'positive.json')).find(e => e.type === 'end')).toMatchObject({ declaredMessages: 4 })
  expect((await collect('qq-shuakami-chunked', 'positive.json')).find(e => e.type === 'end')).toMatchObject({ declaredMessages: 2 })
  const events = await parseSynthetic('chatlab', '{"chatlab":{"version":"0.0.2"},"meta":{"name":"x","platform":"discord","type":"group","messageCount":99},"messages":[]}')
  expect(events.find(e => e.type === 'end')).not.toHaveProperty('declaredMessages')
})
it('cleans only owned temporary data on cancellation and insufficient disk', async () => {
  const { root, source, signal } = await setup()
  const controller = new AbortController()
  const service = createStagingService({ appDataDirectory: join(root, 'app'), freeBytes: async () => { controller.abort(); return 10n ** 15n } })
  const discovery = await service.discover([{ rootPath: source }], signal)
  await expect(service.stageInputs('cancel', discovery, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(await fs.readdir(join(root, 'app', 'import-staging'))).toEqual([])
  const low = createStagingService({ appDataDirectory: join(root, 'app'), freeBytes: async () => 0n })
  await expect(low.stageInputs('low', await low.discover([{ rootPath: source }], signal), signal)).rejects.toMatchObject({ code: 'DISK_SPACE' })
  expect(await fs.stat(join(source, 'chat.json'))).toBeDefined()
})
it('validates QQ single-file totals and individual chunk message counts', async () => {
  expect((await collect('qq-shuakami', 'positive.json')).find(e => e.type === 'end')).toMatchObject({ declaredMessages: 2 })
  const root = JSON.parse(await fs.readFile(resolve('tests/fixtures/import/qq-shuakami-chunked/positive.json'), 'utf8'))
  root.chunked.chunks[0].messages = 99
  const folder = await fs.mkdtemp(join(tmpdir(), 'whomi-count-')); roots.push(folder)
  await fs.cp(resolve('tests/fixtures/import/qq-shuakami-chunked/chunks'), join(folder, 'chunks'), { recursive: true })
  await fs.writeFile(join(folder, 'input.json'), JSON.stringify(root))
  const events = await collect('qq-shuakami-chunked', 'positive.json', { entry: join(folder, 'input.json'), allowedFiles: [join(folder, 'chunks/one.jsonl')] })
  expect(events.some(e => e.type === 'issue' && e.value.code === 'declared-count-mismatch')).toBe(true)
})
it('validates each distinct manifest sharing chunks and preserves their conversation headers', async () => {
  const { source, service, signal } = await setup('qq-shuakami-chunked')
  await fs.cp(resolve('tests/fixtures/import/qq-shuakami-chunked/chunks'), join(source, 'chunks'), { recursive: true })
  const raw = JSON.parse(await fs.readFile(join(source, 'chat.json'), 'utf8'))
  raw.chatInfo.name = 'Synthetic first'
  await fs.writeFile(join(source, 'chat.json'), JSON.stringify(raw))
  raw.chatInfo.name = 'Synthetic second'; raw.statistics.totalMessages = 99
  await fs.writeFile(join(source, 'other.json'), JSON.stringify(raw))
  const stage = await service.stageInputs('shared-chunks', await service.discover([{ rootPath: source }], signal), signal)
  try {
    expect(stage.candidates).toHaveLength(2)
    expect(stage.candidates.find(candidate => candidate.title === 'Synthetic first')?.status).toBe('staged')
    const conflicting = stage.candidates.find(candidate => candidate.title === 'Synthetic second')!
    expect(conflicting.status).toBe('blocked')
    expect(conflicting.issues.map(value => value.code)).toContain('DECLARED_COUNT_MISMATCH')
    expect(conflicting.counts).toEqual({ seen: 2, validRecords: 2, invalidRecords: 0 })
  } finally { await stage.cleanup() }
})
it('keeps fingerprint identity when a single export is renamed, and changes it when a dependency changes', async () => {
  const { root, source, service, signal } = await setup()
  const first = await service.stageInputs('first', await service.discover([{ rootPath: source }], signal), signal)
  const fingerprint = first.candidates[0].fingerprint; await first.cleanup()
  await fs.rename(join(source, 'chat.json'), join(source, 'renamed.json'))
  const second = await service.stageInputs('second', await service.discover([{ rootPath: source }], signal), signal)
  expect(second.candidates[0].fingerprint).toBe(fingerprint); await second.cleanup()
  const bundle = join(root, 'bundle'); await fs.cp(resolve('tests/fixtures/import/google-chat-native'), bundle, { recursive: true })
  const third = await service.stageInputs('third', await service.discover([{ rootPath: join(bundle, 'positive.json') }], signal), signal)
  const old = third.candidates[0].fingerprint; await third.cleanup()
  await fs.appendFile(join(bundle, 'user.json'), ' ')
  const fourth = await service.stageInputs('fourth', await service.discover([{ rootPath: join(bundle, 'positive.json') }], signal), signal)
  expect(fourth.candidates[0].fingerprint).not.toBe(old); await fourth.cleanup()
})
it('blocks every candidate of a damaged shared file and permits an independent valid file', async () => {
  const { source, service, signal } = await setup('telegram-native')
  const raw = JSON.parse(await fs.readFile(join(source, 'chat.json'), 'utf8'))
  raw.chats.list[1].messages[1].text = { invalid: true }
  await fs.writeFile(join(source, 'chat.json'), JSON.stringify(raw))
  await fs.copyFile(resolve('tests/fixtures/import/chatlab/positive.json'), join(source, 'good.json'))
  const stage = await service.stageInputs('shared', await service.discover([{ rootPath: source }], signal), signal)
  expect(stage.candidates.filter(c => c.formatId === 'telegram-native').every(c => c.status === 'blocked')).toBe(true)
  expect(stage.candidates.find(c => c.formatId === 'chatlab')?.status).toBe('staged')
  await stage.cleanup()
})
it('never trusts caller mutation of candidate status or IDs to authorize a blocked group', async () => {
  const { source, service, signal } = await setup('echotrace')
  const raw = JSON.parse(await fs.readFile(join(source, 'chat.json'), 'utf8')); raw.session.messageCount = 100
  await fs.writeFile(join(source, 'chat.json'), JSON.stringify(raw))
  const stage = await service.stageInputs('test', await service.discover([{ rootPath: source }], signal), signal)
  stage.candidates[0].status = 'staged'
  expect(() => stage.conversation([stage.candidates[0].candidateId])).toThrow()
  await stage.cleanup()
})
it('bounds normalized messages at exactly 8 MiB and rejects the next byte', async () => {
  const { root, source, signal } = await setup()
  const message = (await collect('chatlab', 'positive.json')).find(e => e.type === 'message')!.value as ParsedMessage
  message.text = ''
  const overhead = Buffer.byteLength(JSON.stringify(message))
  let payloadSize = 8 * 1024 ** 2 - overhead
  const parser: ParserAdapter = { ...getParsers()[0], id: 'boundary', detect: async () => 100,
    async *parse() {
      yield { type: 'conversation', value: { sourceKey: message.conversationKey, title: 'Synthetic', kind: 'group', identity: { platform: 'x', ownerKey: null, conversationKey: null, namespace: 'x' } } }
      yield { type: 'member', conversationKey: message.conversationKey, value: { sourceKey: message.senderKey!, displayName: 'A', selfHint: null, stableAccountKey: null } }
      yield { type: 'message', value: { ...message, text: 'x'.repeat(payloadSize) } }
      yield { type: 'end', conversationKey: message.conversationKey, seen: 1 }
    } }
  const service = createStagingService({ appDataDirectory: join(root, 'boundary'), parsers: [parser] })
  const discovery = await service.discover([{ rootPath: source }], signal)
  const exact = await service.stageInputs('exact', discovery, signal)
  expect(exact.candidates[0].status).toBe('staged'); await exact.cleanup()
  payloadSize++
  const oversized = await service.stageInputs('over', discovery, signal)
  expect(oversized.candidates[0].counts).toEqual({ seen: 1, validRecords: 0, invalidRecords: 1 })
  expect(oversized.issues.map(i => i.code)).toContain('RECORD_LIMIT'); await oversized.cleanup()
})
it('limits raw streaming records to 8 MiB before decoding or joining oversized lines', async () => {
  const { source, signal } = await setup()
  const path = join(source, 'boundary.jsonl'), input = { candidateId: 'test', entry: path, allowedFiles: [], signal }
  await fs.writeFile(path, 'x'.repeat(8 * 1024 ** 2))
  for await (const line of withSnapshot(input, () => lines(input))) expect(line.length).toBe(8 * 1024 ** 2)
  await fs.appendFile(path, 'x')
  await expect((async () => { for await (const _ of withSnapshot(input, () => lines(input))) { /* consume */ } })()).rejects.toMatchObject({ code: 'record-limit' })
})
it('stops parsing promptly on cancellation and cleans the task directory', async () => {
  const { root, source } = await setup()
  const controller = new AbortController(), parser: ParserAdapter = { ...getParsers()[0], id: 'cancellation-test', detect: async () => 100, async *parse() { controller.abort(); yield { type: 'end', conversationKey: 'x', seen: 0 } } }
  const service = createStagingService({ appDataDirectory: join(root, 'cancel-app'), parsers: [parser] })
  await expect(service.stageInputs('cancel', await service.discover([{ rootPath: source }], controller.signal), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(await fs.readdir(join(root, 'cancel-app', 'import-staging'))).toEqual([])
})
it('rejects cleanup if the owned task directory was replaced with a junction', async () => {
  const { root, source, service, signal } = await setup()
  const stage = await service.stageInputs('test', await service.discover([{ rootPath: source }], signal), signal)
  stage.close()
  const directory = join(stage.path, '..'), held = directory + '-held', outside = join(root, 'outside')
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'sentinel.txt'), 'keep')
  await fs.rename(directory, held)
  await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(stage.cleanup()).rejects.toMatchObject({ code: 'STAGING_PATH' })
  expect(await fs.readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
  await fs.unlink(directory); await fs.rename(held, directory); await stage.cleanup()
})
it.each(['telegram-native-single', 'discord-tyrrrz', 'google-chat-native'])('blocks malformed text objects in %s', async id => {
  const { source, service, signal } = await setup(id)
  if (id === 'google-chat-native') {
    for (const name of ['group.json', 'messages.json', 'user.json']) await fs.copyFile(resolve('tests/fixtures/import/google-chat-native', name), join(source, name))
  }
  const file = join(source, id === 'google-chat-native' ? 'messages.json' : 'chat.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.messages[0][id === 'discord-tyrrrz' ? 'content' : 'text'] = { invalid: true }
  await fs.writeFile(file, JSON.stringify(raw))
  const stage = await service.stageInputs('bad-text', await service.discover([{ rootPath: join(source, 'chat.json') }], signal), signal)
  expect(stage.candidates[0].status).toBe('blocked')
  expect(stage.candidates[0].counts.invalidRecords).toBe(1)
  await stage.cleanup()
})
it.each(getParsers().map(p => p.id))('stages the positive fixture for %s using only the discovered allowlist', async id => {
  const { source, service, signal } = await setup()
  await fs.rm(join(source, 'chat.json'))
  const fixtureRoot = resolve('tests/fixtures/import', id), file = id === 'chatlab-jsonl' ? 'positive.jsonl' : ['qq-native', 'line-native', 'whatsapp-native'].includes(id) ? 'positive.txt' : 'positive.json'
  const fixture = JSON.parse(await fs.readFile(join(fixtureRoot, 'fixture.json'), 'utf8'))
  for (const name of new Set<string>([file, ...fixture.files])) {
    const target = join(source, name); await fs.mkdir(join(target, '..'), { recursive: true }); await fs.copyFile(join(fixtureRoot, name), target)
  }
  const found = await service.discover([{ rootPath: join(source, file) }], signal)
  expect(found.entries).toHaveLength(1)
  const stage = await service.stageInputs(id, found, signal)
  try {
    expect(stage.candidates.length).toBeGreaterThan(0)
    expect(stage.candidates.every(c => c.status === 'staged')).toBe(true)
    expect(stage.counts.seen).toBe(id === 'echotrace' || id === 'telegram-native' ? 4 : 2)
  } finally { await stage.cleanup() }
})
it('accepts Telegram empty text and rich text arrays after malformed shape validation', async () => {
  const { source, service, signal } = await setup('telegram-native-single')
  const file = join(source, 'chat.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.messages[0].text = ''; raw.messages[1].text = ['left ', { type: 'bold', text: 'right' }]
  await fs.writeFile(file, JSON.stringify(raw))
  const stage = await service.stageInputs('rich', await service.discover([{ rootPath: source }], signal), signal)
  try {
    expect(stage.candidates[0].status).toBe('staged')
    expect(stage.preview(stage.candidates[0].candidateId).messages.map(m => m.text)).toEqual(['', 'left right'])
  } finally { await stage.cleanup() }
})
it('accepts a bounded file at 32 MiB and blocks the next byte before snapshotting', async () => {
  const { source, service, signal } = await setup()
  const file = join(source, 'chat.json'), text = await fs.readFile(file)
  await fs.appendFile(file, Buffer.alloc(32 * 1024 ** 2 - text.length, 32))
  const stage = await service.stageInputs('exact', await service.discover([{ rootPath: source }], signal), signal)
  try { expect(stage.candidates[0].status).toBe('staged') } finally { await stage.cleanup() }
  await fs.appendFile(file, ' ')
  const over = await service.discover([{ rootPath: source }], signal)
  expect(over.entries).toHaveLength(0)
  expect(over.issues.map(i => i.code)).toContain('FILE_LIMIT')
}, 20000)
it('counts unknown message types as valid records and does not permit incomplete end counts', async () => {
  const { root, source, signal } = await setup()
  const sourceParser = getParsers().find(p => p.id === 'chatlab')!
  const parser: ParserAdapter = { ...sourceParser, async *parse(input) {
    for await (const event of sourceParser.parse(input)) {
      if (event.type === 'message') yield { ...event, value: { ...event.value, kind: 'unknown' } }
      else if (event.type === 'end') yield { ...event, seen: 3 }
      else yield event
    }
  } }
  const service = createStagingService({ appDataDirectory: join(root, 'count-app'), parsers: [parser] })
  const stage = await service.stageInputs('count', await service.discover([{ rootPath: source }], signal), signal)
  try {
    expect(stage.candidates[0].counts).toEqual({ seen: 2, validRecords: 2, invalidRecords: 0 })
    expect(stage.issues.map(i => i.code)).toContain('RECORD_COUNT_MISMATCH')
    expect(stage.candidates[0].status).toBe('blocked')
  } finally { await stage.cleanup() }
})
it('reads selected candidate groups without claiming a common identity or authorizing a target', async () => {
  const { source, service, signal } = await setup()
  const path = join(source, 'chat.json'), raw = JSON.parse(await fs.readFile(path, 'utf8'))
  raw.meta.ownerId = 'owner'; raw.meta.groupId = 'group'
  await fs.writeFile(path, JSON.stringify(raw)); await fs.copyFile(path, join(source, 'same.json'))
  raw.meta.groupId = 'other'; await fs.writeFile(join(source, 'other.json'), JSON.stringify(raw))
  const stage = await service.stageInputs('groups', await service.discover([{ rootPath: source }], signal), signal)
  try {
    const matching = stage.candidates.filter(c => c.identity.conversationKey === 'group')
    expect([...stage.conversation(matching.map(c => c.candidateId)).messages()]).toHaveLength(4)
    const group = stage.conversation(stage.candidates.map(c => c.candidateId))
    expect([...group.messages()]).toHaveLength(6)
    expect(group.sources.map(c => c.identity.conversationKey)).toEqual(expect.arrayContaining(['group', 'other']))
    expect(group).not.toHaveProperty('identity')
    expect(() => stage.conversation([matching[0].candidateId, matching[0].candidateId])).toThrow()
    expect(() => stage.conversation(['another-job-id'])).toThrow()
  } finally { await stage.cleanup() }
})
it('rejects a parent directory swapped to an outside junction between path check and descriptor open without reading bytes', async () => {
  const { root, source, signal } = await setup()
  const outside = join(root, 'outside'), held = source + '-held'
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'chat.json'), 'outside-secret')
  let swap = false, reads = 0
  const service = createStagingService({ appDataDirectory: join(root, 'race-app'), access: {
    open: async (path, flags) => {
      if (swap) {
        swap = false
        await fs.rename(source, held)
        await fs.symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
        const handle = await fs.open(path, flags), read = handle.read.bind(handle)
        handle.read = (async (...args: Parameters<typeof handle.read>) => { reads++; return read(...args) }) as typeof handle.read
        return handle
      }
      return fs.open(path, flags)
    },
  } })
  const discovery = await service.discover([{ rootPath: source }], signal); swap = true
  const stage = await service.stageInputs('race', discovery, signal)
  try {
    expect(reads).toBe(0)
    expect(stage.issues.map(i => i.code)).toContain('SOURCE_CHANGED')
  } finally { await stage.cleanup() }
})
