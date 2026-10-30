import { afterEach, expect, test } from 'vitest'
import { normalizeSiwx } from '../../electron/data/parsers/siwx-normalizer'
import { normalizeModel } from '../../src/shared/conversation-model'
import { openStore } from '../../electron/data/db/open'
import { createQueries } from '../../electron/data/db/queries'
import { commitConversation } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { candidate, view } from './import-fixture'
import { message, temporaryStore } from './helpers'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const targetId = '9007199254740993123'
const raw = {
  platformMessageId: '9007199254740993124', createTime: 1700000010,
  senderUsername: 'example-b', senderDisplayName: '示例乙', typeName: '引用消息', content: '好的',
  quote: { displayname: '示例甲', content: '周六见', ts: 1700000000 },
  rawContent: `<msg><appmsg><refermsg type="1"><svrid>${targetId}</svrid><content>周六见</content></refermsg></appmsg></msg>`,
}

test('SIWX retains the exact server target and its exported sender and time', () => {
  const parsed = normalizeSiwx(raw, normalizeModel(message()))
  expect(parsed.reply).toEqual({ originalId: targetId, idNamespace: 'wechat:server-message', text: '周六见', senderName: '示例甲', sentAtMs: 1700000000000 })
  expect(parsed.text).toBe('好的')
})

test.each(['', '<msg><appmsg><svrid>123</svrid></appmsg></msg>', '<refermsg><svrid>0</svrid></refermsg>', '<refermsg><svrid>1.2</svrid></refermsg>'])('SIWX never invents a target from missing or invalid reference metadata: %s', rawContent => {
  expect(normalizeSiwx({ ...raw, rawContent }, normalizeModel(message())).reply?.originalId).toBeNull()
})

test('SIWX accepts reference attributes and a CDATA server id without parsing it as a number', () => {
  const parsed = normalizeSiwx({ ...raw, rawContent: `<refermsg type="1"><svrid><![CDATA[${targetId}]]></svrid></refermsg>` }, normalizeModel(message()))
  expect(parsed.reply?.originalId).toBe(targetId)
})

test('reimport enriches old SIWX reply metadata without duplicating or rewriting messages', async () => {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanups.push(() => { store.close(); temp.cleanup() })
  function staged(enriched: boolean, key: string) {
    const job = store.writer.prepare("INSERT INTO import_jobs(status,created_at_ms) VALUES ('running',0)").run().lastInsertRowid.toString()
    const item = candidate(key), staged = view(job, [item], [[targetId, raw.platformMessageId]])
    const records = staged.messages
    staged.messages = function* () {
      for (const record of records()) {
        const isReply = record.message.ordinal === 1
        record.message.idNamespace = 'wechat:server-message'
        record.message.text = isReply ? '好的' : '周六见'
        if (isReply) {
          record.message.kind = 'reply'
          record.message.reply = enriched ? normalizeSiwx(raw, normalizeModel(message())).reply : { originalId: null, idNamespace: null, text: '周六见', senderName: null, sentAtMs: null }
        }
        yield record
      }
    }
    const resolved = resolveTarget(store, item)
    if (resolved.status !== 'matched') throw Error('fixture target')
    return { staged, target: resolved.target }
  }
  const old = staged(false, 'a')
  await commitConversation(store, old.staged, old.target, new AbortController().signal)
  const before = store.reader.prepare('SELECT * FROM messages ORDER BY id').all()
  const enriched = staged(true, 'b')
  const result = await commitConversation(store, enriched.staged, enriched.target, new AbortController().signal)
  expect(result).toMatchObject({ inserted: 0, duplicates: 2 })
  expect(store.reader.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before)
  const rows = (await createQueries(store).readMessages({ conversationId: result.conversationId, direction: 'after' })).items
  expect(rows[1].reply).toMatchObject({ targetMessageId: rows[0].id, state: 'resolved', senderName: '示例甲', sentAtMs: 1700000000000 })
})
