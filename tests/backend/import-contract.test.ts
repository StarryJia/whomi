import { it, expect } from 'vitest'
import { mkdtemp, mkdir, copyFile, readFile, rm, realpath } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { openStore } from '../../electron/data/db/open'
import { createDataService } from '../../electron/data/service'
import { createQueries } from '../../electron/data/db/queries'

const formats = [
  ['chatlab', 2], ['chatlab-jsonl', 2], ['qq-shuakami', 2], ['qq-shuakami-chunked', 2], ['weflow', 2], ['echotrace', 4],
  ['discord-tyrrrz', 2], ['telegram-native', 4], ['telegram-native-single', 2], ['google-chat-native', 2], ['instagram-native', 2],
  ['whatsapp-native', 2], ['qq-native', 2], ['line-native', 2],
] as const
it.each(formats)('%s follows the same snapshot, preview, atomic save, exact reimport and reopened read contract', async (format, count) => {
  const root = await mkdtemp(join(tmpdir(), 'whomi-contract-')), source = join(root, 'source'), directory = join(root, 'app')
  await mkdir(source); await mkdir(directory)
  const fixture = resolve('tests/fixtures/import', format), manifest = JSON.parse(await readFile(join(fixture, 'fixture.json'), 'utf8')) as { files: string[] }
  for (const file of manifest.files) { await mkdir(dirname(join(source, file)), { recursive: true }); await copyFile(join(fixture, file), join(source, file)) }
  async function hash() { const hash = createHash('sha256'); for (const file of manifest.files) hash.update(file).update(await readFile(join(source, file))); return hash.digest('hex') }
  const before = await hash()
  let store = openStore(join(directory, 'whomi.db'))
  try {
    const service = createDataService({ store, appDataDirectory: directory })
    async function stage() {
      const jobId = await service.prepareImport([{ rootPath: source }])
      const discovered = (await service.getImport(jobId)).discovery!
      const entries = discovered.entries.filter(entry => entry.formatId === format)
      expect(entries).toHaveLength(1)
      await service.startImport({ kind: 'stage', jobId, entryIds: entries.map(entry => entry.entryId) }); await service.idle()
      const staged = await service.getImport(jobId)
      expect(staged.status).toBe('awaiting_commit'); expect(staged.candidates.every(c => c.status === 'staged')).toBe(true)
      for (const c of staged.candidates) expect((await service.previewImport(jobId, c.candidateId, { limit: 1 })).messages).toHaveLength(1)
      return staged
    }
    const first = await stage()
    await service.startImport({ kind: 'commit', plan: { jobId: first.jobId, decisions: first.candidates.map(c => ({ candidateId: c.candidateId, target: { kind: 'new' as const }, confirmedAliases: [] })) } }); await service.idle()
    const saved = await service.getImport(first.jobId)
    expect(saved.status).toBe('completed'); expect(saved.inserted).toBe(count)
    const second = await stage()
    await service.startImport({ kind: 'commit', plan: { jobId: second.jobId, decisions: second.candidates.map(c => ({ candidateId: c.candidateId, target: { kind: 'existing' as const, conversationId: saved.results.find(r => r.candidateId === first.candidates.find(old => old.sourceKey === c.sourceKey)!.candidateId)!.conversationId! }, confirmedAliases: [] })) } }); await service.idle()
    const reimported = await service.getImport(second.jobId)
    expect(reimported.status).toBe('completed')
    expect(reimported.inserted).toBe(0)
    expect(reimported.duplicates).toBe(count)
    expect(reimported.results).toHaveLength(second.candidates.length)
    for (const candidate of second.candidates) {
      const result = reimported.results.find(result => result.candidateId === candidate.candidateId)
      expect(result).toMatchObject({ status: 'duplicate', inserted: 0, duplicates: candidate.counts.validRecords })
      expect(result!.committedAt).toEqual(expect.any(Number))
    }
    store.close(); store = openStore(join(directory, 'whomi.db'))
    const queries = createQueries(store), conversations = (await queries.listConversations({})).items
    expect(conversations.reduce((total, c) => total+c.messageCount, 0)).toBe(count)
    let read = 0
    for (const c of conversations) {
      const page = await queries.readMessages({ conversationId: c.id, direction: 'after' }); read += page.items.length
      expect((await queries.locateSource({ conversationId: c.id, messageId: page.items[0].id })).status).toBe('available')
    }
    expect(read).toBe(count); expect(await hash()).toBe(before)
  } finally {
    store.close()
    const actual = await realpath(root)
    if (dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('whomi-contract-')) throw Error('Unexpected contract directory')
    await rm(actual, { recursive: true, force: true })
  }
})
