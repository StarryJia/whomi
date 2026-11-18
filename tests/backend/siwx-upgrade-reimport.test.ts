import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore, type Store } from '../../electron/data/db/open'
import { resolveAutoTarget } from '../../electron/data/import/auto-target'
import { commitConversation } from '../../electron/data/import/merge'
import { createStagingService, type StagedConversation } from '../../electron/data/import/staging'
import type { ParsedMessage } from '../../src/shared/conversation-model'
import { temporaryStore } from './helpers'

type HistoricalFields = Partial<Pick<ParsedMessage, 'kind' | 'reply'>>
const olderParser = 'f19beeadda27b-whomi.2'
const noReference = { originalId: null, idNamespace: null, text: null, senderName: null, sentAtMs: null }

let store: Store, temporary: ReturnType<typeof temporaryStore>
beforeEach(() => { temporary = temporaryStore(); store = openStore(temporary.path) })
afterEach(() => { store.close(); temporary.cleanup() })

function rawMessage(index: number, overrides: Record<string, unknown> = {}) {
  return {
    localType: 1, typeName: '文本消息', content: `合成正文 ${index}`, senderUsername: 'example-peer',
    senderDisplayName: '合成用户', createTime: 1700000000 + index, serverId: '0', isSend: 0, ...overrides,
  }
}

function rawReply(rawContent: string, overrides: Record<string, unknown> = {}) {
  return rawMessage(2, {
    localType: 49, typeName: '引用消息', quote: { content: '合成摘录', displayname: '合成用户' }, rawContent, ...overrides,
  })
}

function exportFor(messages: ReturnType<typeof rawMessage>[]) {
  return {
    exportInfo: { exporter: 'SIWX', wxid: 'example-owner' },
    session: { wxid: 'example-peer', type: '私聊', messageCount: messages.length },
    messages,
  }
}

async function importFile(messages: ReturnType<typeof rawMessage>[], historical?: Record<number, HistoricalFields>, historicalVersion = olderParser) {
  const directory = dirname(temporary.path), file = join(directory, 'export.json')
  // Distinct export bytes bypass the exact file fingerprint path without changing message contents.
  await writeFile(file, JSON.stringify(exportFor(messages), null, historical ? 2 : 0))
  const service = createStagingService({ appDataDirectory: directory }), signal = new AbortController().signal
  const discovery = await service.discover([{ rootPath: file }], signal)
  expect(discovery.entries.map(entry => entry.formatId)).toEqual(['echotrace'])
  const jobId = store.writer.prepare("INSERT INTO import_jobs(status,created_at_ms) VALUES ('running',0)").run().lastInsertRowid.toString()
  const staged = await service.stageInputs(jobId, discovery, signal)
  try {
    const [candidate] = staged.candidates
    expect(candidate.status).toBe('staged')
    const current = staged.conversation([candidate.candidateId])
    // Use the real parser, membership and snapshot, substituting only fields the older parser saved differently.
    const records: StagedConversation = historical ? {
      ...current,
      candidates: [{ ...candidate, parserVersion: historicalVersion }],
      *messages() {
        for (const row of current.messages()) yield {
          ...row,
          origin: { ...row.origin, parserVersion: historicalVersion },
          message: { ...row.message, ...historical[row.message.ordinal] },
        }
      },
    } : current
    const target = await resolveAutoTarget(store, records.candidates[0], () => records.messages(), signal)
    if (target.status !== 'matched') throw Error(target.status)
    const saved = await commitConversation(store, records, target.target, signal)
    return { ...saved, ownerKey: candidate.identity.ownerKey, fingerprint: candidate.fingerprint }
  } finally { await staged.cleanup() }
}

test('a newly recognized contact between five known records still matches the conversation with no known owner', async () => {
  const messages = [1, 2, 3, 4, 5, 6].map(index => index === 3
    ? rawMessage(index, { localType: 42, typeName: '名片消息', content: '合成名片' }) : rawMessage(index))
  const previous = await importFile(messages, { 2: { kind: 'unknown' } })
  expect(previous).toMatchObject({ ownerKey: null, inserted: 6 })
  const reimported = await importFile(messages)
  expect(reimported.fingerprint).not.toBe(previous.fingerprint)
  expect(reimported).toMatchObject({ conversationId: previous.conversationId, inserted: 0, duplicates: 6 })
  expect(store.reader.prepare('SELECT count(*) AS count FROM conversations').get()).toEqual({ count: 1n })
})

function messagesWithShare(subtype: number) {
  return [1, 2, 3, 4, 5, 6].map(index => index === 3 ? rawMessage(index, {
    localType: 49, typeName: '链接/文件', content: '合成音乐分享',
    rawContent: `<msg><appmsg><type>${subtype}</type></appmsg></msg>`,
  }) : rawMessage(index))
}

test('newly recognized music shares still match conversations imported before share recognition', async () => {
  const messages = messagesWithShare(76)
  const previous = await importFile(messages, { 2: { kind: 'unknown' } }, 'f19beeadda27b-whomi.3')
  expect(previous).toMatchObject({ ownerKey: null, inserted: 6 })
  const reimported = await importFile(messages)
  expect(reimported.fingerprint).not.toBe(previous.fingerprint)
  expect(reimported).toMatchObject({ conversationId: previous.conversationId, inserted: 0, duplicates: 6 })
})

test('an earlier match window cannot be used against a conversation imported only with the current parser', async () => {
  const previous = await importFile(messagesWithShare(999))
  expect(previous).toMatchObject({ ownerKey: null, inserted: 6 })
  const arrived = await importFile(messagesWithShare(76))
  expect(arrived.conversationId).not.toBe(previous.conversationId)
  expect(arrived).toMatchObject({ inserted: 6, duplicates: 0 })
})

test('a malformed quote saved as an empty legacy reply is a duplicate after reexport', async () => {
  const messages = [
    rawMessage(1, { senderUsername: 'example-owner', isSend: 1 }),
    rawMessage(2, { localType: 49, typeName: '链接/文件', quote: { bad: true } }),
  ]
  const previous = await importFile(messages, { 1: { kind: 'reply', reply: noReference } })
  expect(previous).toMatchObject({ ownerKey: 'example-owner', inserted: 2 })
  const reimported = await importFile(messages)
  expect(reimported.fingerprint).not.toBe(previous.fingerprint)
  expect(reimported).toMatchObject({ conversationId: previous.conversationId, inserted: 0, duplicates: 2 })
  expect(store.reader.prepare('SELECT kind FROM messages ORDER BY id').all()).toEqual([{ kind: 'text' }, { kind: 'reply' }])
})

test('a legacy quote with a corrected target only offsets one matching occurrence', async () => {
  const sent = rawMessage(1, { senderUsername: 'example-owner', isSend: 1 })
  const corrected = rawReply('<msg><appmsg><type>57</type><refermsg><content><![CDATA[<svrid>101</svrid>]]></content><svrid>202</svrid></refermsg></appmsg></msg>')
  const previous = await importFile([sent, corrected], { 1: { reply: {
    ...noReference, originalId: '101', idNamespace: 'wechat:server-message', text: '合成摘录', senderName: '合成用户',
  } } })
  expect(previous.inserted).toBe(2)
  const distinctTarget = rawReply('<msg><appmsg><type>57</type><refermsg><svrid>303</svrid></refermsg></appmsg></msg>')
  const withStableId = { ...corrected, serverId: '9007199254740993124' }
  const reimported = await importFile([sent, withStableId, corrected, corrected, distinctTarget])
  expect(reimported.fingerprint).not.toBe(previous.fingerprint)
  expect(reimported).toMatchObject({ conversationId: previous.conversationId, inserted: 3, duplicates: 2 })
  expect(store.reader.prepare('SELECT original_id FROM message_replies ORDER BY message_id').all())
    .toEqual([{ original_id: '101' }, { original_id: '202' }, { original_id: '202' }, { original_id: '303' }])
  expect(store.reader.prepare('SELECT original_id FROM message_keys').all()).toEqual([{ original_id: withStableId.serverId }])
})

test('exact and legacy signatures share one occurrence of a saved reply', async () => {
  const sent = rawMessage(1, { senderUsername: 'example-owner', isSend: 1 })
  const direct = rawReply('<msg><appmsg><type>57</type><refermsg><svrid>101</svrid></refermsg></appmsg></msg>')
  const corrected = rawReply('<msg><appmsg><type>57</type><refermsg><content><![CDATA[<svrid>101</svrid>]]></content><svrid>202</svrid></refermsg></appmsg></msg>')
  const previous = await importFile([sent, direct], {})
  expect(previous.inserted).toBe(2)
  const reimported = await importFile([sent, corrected, direct])
  expect(reimported).toMatchObject({ conversationId: previous.conversationId, inserted: 1, duplicates: 2 })
})
