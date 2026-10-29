import { describe, expect, it } from 'vitest'
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getParsers } from '../../electron/data/parsers/registry'
import { collect, parseSynthetic } from './parser-helpers'
import { parseJson } from '../../electron/data/parsers/input'
import { withSnapshot, createReadStream, readFileSync } from '../../electron/data/parsers/snapshot-fs'


const cases = [
  ['chatlab', 'positive.json', 2], ['chatlab-jsonl', 'positive.jsonl', 2],
  ['qq-shuakami', 'positive.json', 2], ['qq-shuakami-chunked', 'positive.json', 2],
  ['weflow', 'positive.json', 2], ['echotrace', 'positive.json', 4],
  ['discord-tyrrrz', 'positive.json', 2], ['telegram-native', 'positive.json', 4],
  ['telegram-native-single', 'positive.json', 2], ['google-chat-native', 'positive.json', 2],
  ['instagram-native', 'positive.json', 2], ['whatsapp-native', 'positive.txt', 2],
  ['qq-native', 'positive.txt', 2], ['line-native', 'positive.txt', 2],
] as const

describe.each(cases)('%s contract', (id, file, count) => {
  it('detects its synthetic export without accepting unrelated data', async () => {
    const parser = getParsers().find(p => p.id === id)!
    const prefix = await readFile(resolve('tests/fixtures/import', id, file))
    expect(await parser.detect({ extension: file.slice(file.lastIndexOf('.')), prefix: prefix.subarray(0, 65536), size: prefix.length })).toBeGreaterThan(0)
    expect(await parser.detect({ extension: '.json', prefix: Buffer.from('{"unrelated":true}'), size: 18 })).toBe(0)
  })
  it('preserves raw record counts and conversation boundaries', async () => {
    const events = await collect(id, file)
    expect(events.filter(e => e.type === 'issue' && e.value.severity === 'blocking')).toEqual([])
    expect(events.filter(e => e.type === 'message')).toHaveLength(count)
    expect(events.filter(e => e.type === 'end').reduce((n, e) => n + (e.type === 'end' ? e.seen : 0), 0)).toBe(count)
    expect(events.filter(e => e.type === 'conversation')).toHaveLength(id === 'telegram-native' ? 2 : 1)
  })
  it('blocks corrupt input with a sanitized diagnostic', async () => {
    const events = await collect(id, 'corrupt' + file.slice(file.lastIndexOf('.')))
    expect(events.some(e => e.type === 'issue' && e.value.severity === 'blocking')).toBe(true)
    expect(JSON.stringify(events.filter(e => e.type === 'issue'))).not.toContain('PRIVATE_SENTINEL')
  })
  it('reports missing structural fields instead of successful empty import', async () => {
    const events = await collect(id, 'missing' + file.slice(file.lastIndexOf('.')))
    expect(events.some(e => e.type === 'issue')).toBe(true)
  })
})

it('cancels before producing records', async () => {
  const controller = new AbortController(); controller.abort()
  const events = await collect('chatlab', 'positive.json', { signal: controller.signal })
  expect(events.filter(e => e.type === 'message')).toHaveLength(0)
  expect(events.some(e => e.type === 'issue' && e.value.code === 'cancelled')).toBe(true)
})

it('enforces input and record limits', async () => {
  const events = await collect('chatlab', 'positive.json', { limits: { maxFileBytes: 10, maxRecordBytes: 8 } })
  expect(events.some(e => e.type === 'issue' && e.value.code === 'file-limit')).toBe(true)
  const records = await collect('chatlab-jsonl', 'positive.jsonl', { limits: { maxRecordBytes: 10 } })
  expect(records.some(e => e.type === 'issue' && e.value.code === 'record-limit')).toBe(true)
})

it('rejects manifest access to an unlisted chunk', async () => {
  const events = await collect('qq-shuakami-chunked', 'positive.json', { allowedFiles: [] })
  expect(events.some(e => e.type === 'issue' && e.value.severity === 'blocking')).toBe(true)
})

it('keeps unquoted large message identifiers before upstream rounding', async () => {
  const events = await parseSynthetic('chatlab', '{"chatlab":{"version":"0.0.2"},"meta":{"name":"Synthetic","platform":"discord","type":"group"},"messages":[{"sender":"a","accountName":"A","timestamp":0,"type":0,"content":"x","platformMessageId":9007199254740993123}]}')
  expect(events.find(e => e.type === 'message')).toMatchObject({ value: { originalId: '9007199254740993123', sentAtMs: 0 } })
})

it('keeps duplicate-looking raw records and normalizes empty source keys', async () => {
  const message = { sender: '', accountName: '', timestamp: 0, type: 4567, content: 'same\n', platformMessageId: '' }
  const events = await parseSynthetic('chatlab', JSON.stringify({ chatlab: { version: '0.0.2' }, meta: { name: 'Synthetic', platform: 'discord', type: 'group', ownerId: '', groupId: '' }, messages: [message, message] }))
  const values = events.flatMap(e => e.type === 'message' ? [e.value] : [])
  expect(values).toHaveLength(2)
  expect(values.map(m => m.ordinal)).toEqual([0, 1])
  expect(values[0]).toMatchObject({ originalId: null, idNamespace: null, kind: 'unknown', senderKind: 'unknown', sentAtMs: 0, text: 'same\n' })
  expect(events.find(e => e.type === 'conversation')).toMatchObject({ value: { identity: { ownerKey: null, conversationKey: null } } })
})

it('preserves Telegram records whose absent timestamp upstream skips', async () => {
  const raw = JSON.parse(await readFile(resolve('tests/fixtures/import/telegram-native/positive.json'), 'utf8'))
  delete raw.chats.list[0].messages[0].date_unixtime
  const events = await parseSynthetic('telegram-native', JSON.stringify(raw))
  expect(events.filter(e => e.type === 'message')).toHaveLength(4)
  expect(events.find(e => e.type === 'message')).toMatchObject({ value: { ordinal: 0, sentAtMs: null, text: 'message 1' } })
  expect(events.some(e => e.type === 'issue' && e.value.code === 'upstream-skipped-records')).toBe(true)
})

it('keeps text format whitespace and unzoned raw time without guessing timezone', async () => {
  const source = '消息记录\n消息对象:Synthetic\n2023-11-14 22:13:20 A(10001)\n 好\n\n2023-11-14 22:13:20 B(10002)\n第二条'
  const events = await parseSynthetic('qq-native', source)
  expect(events.find(e => e.type === 'message')).toMatchObject({ value: { text: ' 好\n', sentAtMs: null, timezone: null, timeRaw: '2023-11-14 22:13:20' } })
})

it('counts every invalid JSONL record instead of silently skipping it', async () => {
  const header = '{"_type":"header","chatlab":{"version":"0.0.2"},"meta":{"name":"Synthetic","platform":"discord","type":"group"}}'
  const events = await parseSynthetic('chatlab-jsonl', header + '\n{"_type":"message", broken')
  expect(events.some(e => e.type === 'issue' && e.value.severity === 'blocking' && e.value.ordinal === 0)).toBe(true)
  expect(events.some(e => e.type === 'end')).toBe(false)
})

it('isolates parallel manifest parse contexts', async () => {
  const [valid, denied] = await Promise.all([collect('google-chat-native'), collect('google-chat-native', 'positive.json', { allowedFiles: [] })])
  expect(valid.filter(e => e.type === 'message')).toHaveLength(2)
  expect(denied.filter(e => e.type === 'message')).toHaveLength(0)
  expect(denied.some(e => e.type === 'issue' && e.value.severity === 'blocking')).toBe(true)
})

it('rejects an entry reached through a junction alias', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'whomi-alias-'))
  const target = resolve(dir, 'target'), alias = resolve(dir, 'alias')
  try {
    await mkdir(target)
    await writeFile(resolve(target, 'input.json'), await readFile(resolve('tests/fixtures/import/chatlab/positive.json')))
    await symlink(target, alias, 'junction')
    const events = await collect('chatlab', 'positive.json', { entry: resolve(alias, 'input.json'), allowedFiles: [] })
    expect(events.filter(e => e.type === 'message')).toHaveLength(0)
    expect(events.some(e => e.type === 'issue' && e.value.severity === 'blocking')).toBe(true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('blocks excessive JSON nesting before upstream filters assemble any conversation', async () => {
  const source = await readFile(resolve('tests/fixtures/import/chatlab/positive.json'), 'utf8')
  const events = await parseSynthetic('chatlab', source.slice(0, source.lastIndexOf('}')) + ',"nested":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}')
  expect(events.some(e => e.type === 'issue' && e.value.code === 'json-depth')).toBe(true)
  expect(events.some(e => e.type === 'conversation')).toBe(false)
})

it.each(['__proto__', '\\u005f_proto__', 'constructor', 'prototype'])('blocks dangerous JSON property %s before upstream assembly', async key => {
  const source = await readFile(resolve('tests/fixtures/import/chatlab/positive.json'), 'utf8')
  const events = await parseSynthetic('chatlab', source.slice(0, source.lastIndexOf('}')) + ',"' + key + '":{"polluted":true}}')
  expect(events.some(e => e.type === 'issue' && e.value.code === 'unsafe-property')).toBe(true)
  expect(events.some(e => e.type === 'conversation')).toBe(false)
})

it('accepts JSON string contents that resemble nesting or special property names', () => {
  expect(parseJson(JSON.stringify({ text: '[{'.repeat(200) + '__proto__ "constructor":' }))).toEqual({ text: '[{'.repeat(200) + '__proto__ "constructor":' })
})

it('rejects JSON with comments before reaching an upstream parser', () => {
  expect(() => parseJson('{/* comment */"messages":[]}')).toThrow()
})

it.each(['chatlab', 'chatlab-jsonl'])('preserves declared inactive members in %s without promoting local account keys', async id => {
  const meta = { name: 'Synthetic', platform: 'example-local', type: 'group', ownerId: 'inactive' }
  const declared = [{ platformId: 'inactive', accountName: 'Example Owner', groupNickname: 'Example Nick' }]
  const message = { sender: 'active', accountName: 'Example Sender', timestamp: 0, type: 0, content: 'test' }
  const text = id === 'chatlab' ? JSON.stringify({ chatlab: { version: '0.0.2' }, meta, members: declared, messages: [message] })
    : [JSON.stringify({ _type: 'header', chatlab: { version: '0.0.2' }, meta }), ...declared.map(m => JSON.stringify({ _type: 'member', ...m })), JSON.stringify({ _type: 'message', ...message })].join('\n')
  const events = await parseSynthetic(id, text)
  const members = events.flatMap(e => e.type === 'member' ? [e.value] : [])
  expect(members).toContainEqual({ sourceKey: 'inactive', displayName: 'Example Nick', stableAccountKey: null, selfHint: true })
  expect(members.find(m => m.sourceKey === 'active')?.stableAccountKey).toBeNull()
})

it('caps the combined Google Chat manifest and dependency size', async () => {
  const events = await collect('google-chat-native', 'positive.json', { limits: { maxFileBytes: 700 } })
  expect(events.some(e => e.type === 'issue' && e.value.code === 'file-limit')).toBe(true)
  expect(events.some(e => e.type === 'message')).toBe(false)
})

it('retains Instagram participants who did not send a message without a stable account claim', async () => {
  const raw = JSON.parse(await readFile(resolve('tests/fixtures/import/instagram-native/positive.json'), 'utf8'))
  raw.participants.push({ name: 'Example Silent Participant' })
  const events = await parseSynthetic('instagram-native', JSON.stringify(raw))
  expect(events.flatMap(e => e.type === 'member' ? [e.value] : [])).toContainEqual({
    sourceKey: 'Example Silent Participant', displayName: 'Example Silent Participant', stableAccountKey: null, selfHint: null,
  })
})

it('keeps lazy stream reads scoped and rejects replacement before opening a descriptor', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'whomi-facade-'))
  const entry = resolve(dir, 'input'), other = resolve(dir, 'other')
  try {
    await writeFile(entry, 'allowed')
    await writeFile(other, 'outside-list')
    const input = { candidateId: 'synthetic', entry, allowedFiles: [], signal: new AbortController().signal }
    const iterator = withSnapshot(input, async function* () {
      yield 'ready'
      expect(() => readFileSync(other, 'utf8')).toThrow('snapshot-access')
      const stream = createReadStream(entry, { highWaterMark: 2 })
      let text = ''
      for await (const bytes of stream) text += bytes.toString()
      yield text
      await rename(entry, resolve(dir, 'old'))
      await writeFile(entry, 'replaced')
      expect(() => createReadStream(entry)).toThrow('snapshot-access')
      yield 'rejected'
    })
    expect((await iterator.next()).value).toBe('ready')
    expect((await iterator.next()).value).toBe('allowed')
    expect((await iterator.next()).value).toBe('rejected')
    expect((await iterator.next()).done).toBe(true)
    expect(() => readFileSync(entry, 'utf8')).toThrow('snapshot-access')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
