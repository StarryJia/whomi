import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore, type Store } from '../../electron/data/db/open'
import { commitConversation } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { resolveAutoTarget } from '../../electron/data/import/auto-target'
import { conversation } from '../../electron/data/parsers/normalize'
import { temporaryStore } from './helpers'
import { candidate, view } from './import-fixture'
import type { Candidate } from '../../src/shared/import-contract'

let store: Store, temp: ReturnType<typeof temporaryStore>
beforeEach(() => { temp = temporaryStore(); store = openStore(temp.path) })
afterEach(() => { store.close(); temp.cleanup() })
function records(c: Candidate, values: number[], stableIds = false) {
  c.members = [{ sourceKey: 'sender', stableAccountKey: 'account', displayName: '示例用户', selfHint: null }]
  const jobId = store.writer.prepare("INSERT INTO import_jobs(status,created_at_ms) VALUES ('running',0)").run().lastInsertRowid.toString()
  const v = view(jobId, [c], [values.map(String)]), read = v.messages
  v.messages = function* () { for (const r of read()) {
    const n = Number(r.message.text)
    yield { ...r, message: { ...r.message, senderKey: 'sender', senderKind: 'member' as const,
      sentAtMs: n * 1000 + 1000, timePrecision: 'millisecond' as const, timezone: 'UTC',
      originalId: stableIds ? String(n) : null, idNamespace: stableIds ? 'test' : null } }
  } }
  return v
}
async function save(c: Candidate, values: number[], stableIds = false) {
  const v = records(c, values, stableIds), target = await resolveAutoTarget(store, c, () => v.messages())
  if (target.status !== 'matched') throw Error(target.status)
  return commitConversation(store, v, target.target, new AbortController().signal)
}
function unknown(id: string) { const c = candidate(id); c.identity.ownerKey = null; c.identity.conversationKey = null; return c }

test('an unknown source uniquely overlaps the old trailing five records and appends only new messages', async () => {
  await save(unknown('a'), [0, 1, 2, 3, 4, 5])
  expect(await save(unknown('b'), [1, 2, 3, 4, 5, 6])).toMatchObject({ conversationId: '1', inserted: 1, duplicates: 5 })
  expect(await save(unknown('c'), [1, 2, 3, 4, 5, 6])).toMatchObject({ conversationId: '1', inserted: 0, duplicates: 6 })
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({ n: 7n })
})
test('fewer than five overlapping messages and duplicate candidates both create a new conversation', async () => {
  await save(unknown('a'), [0, 1, 2, 3, 4])
  expect(await save(unknown('short'), [1, 2, 3, 4])).toMatchObject({ conversationId: '2', inserted: 4 })
  const duplicate = records(unknown('copy'), [0, 1, 2, 3, 4])
  const explicit = resolveTarget(store, duplicate.candidates[0], { candidateId: 'copy', target: { kind: 'new' }, confirmedAliases: [] })
  if (explicit.status !== 'matched') throw Error('target')
  await commitConversation(store, duplicate, explicit.target, new AbortController().signal)
  expect(await save(unknown('ambiguous'), [0, 1, 2, 3, 4, 5])).toMatchObject({ conversationId: '4', inserted: 6 })
})
test('the same short file reuses its exact saved origins without requiring five messages', async () => {
  const first = unknown('first'); first.fingerprint = 'same-bytes'
  const second = unknown('second'); second.fingerprint = 'same-bytes'
  await save(first, [1, 2])
  expect(await save(second, [1, 2])).toMatchObject({conversationId:'1',inserted:0,duplicates:2})
})
test('an exact file mapped to several conversations creates a new target', async () => {
  const a=unknown('a');a.fingerprint='same-bytes'
  await save(a,[1,2])
  const b=unknown('b');b.fingerprint='same-bytes'
  const v=records(b,[1,2]),t=resolveTarget(store,b,{candidateId:'b',target:{kind:'new'},confirmedAliases:[]})
  if(t.status!=='matched')throw Error('target')
  await commitConversation(store,v,t.target,new AbortController().signal)
  const c=unknown('c');c.fingerprint='same-bytes'
  expect(await save(c,[1,2])).toMatchObject({conversationId:'3',inserted:2})
})
test('explicit account conflicts prevent a trailing match even when all five messages are equal', async () => {
  await save(candidate('a'), [0, 1, 2, 3, 4])
  const c = candidate('b'); c.identity.ownerKey = 'other-owner'
  expect(await save(c, [0, 1, 2, 3, 4, 5])).toMatchObject({ conversationId: '2', inserted: 6 })
})
test('stable identities append old backfill and preserve distinct stable identifiers with identical content', async () => {
  await save(candidate('a'), [3, 4, 5], true)
  expect(await save(candidate('b'), [0, 1, 2, 3, 4, 5], true)).toMatchObject({ inserted: 3, duplicates: 3 })
  const c = candidate('same-text'), v = records(c, [9, 10], true), read = v.messages
  v.messages = function* () { for (const r of read()) yield { ...r, message: { ...r.message, text: '相同正文', sentAtMs: 1000 } } }
  const t = await resolveAutoTarget(store, c, () => v.messages()); if (t.status !== 'matched') throw Error('target')
  expect(await commitConversation(store, v, t.target, new AbortController().signal)).toMatchObject({ inserted: 2, duplicates: 0 })
})
test('fallback deduplication preserves repeated occurrences at the same timestamp', async () => {
  expect(await save(candidate('a'), [1, 1])).toMatchObject({ inserted: 2 })
  expect(await save(candidate('b'), [1, 1, 1])).toMatchObject({ inserted: 1, duplicates: 2 })
})
test('candidate read errors propagate rather than producing a new-conversation decision', async () => {
  const c = unknown('broken')
  await expect(resolveAutoTarget(store, c, function* () { throw Error('read failed') })).rejects.toThrow('read failed')
})
test('normalization retains a parser-supplied exporter account identity', () => {
  expect(conversation('telegram-native', { id: 'chat' }, { platform: 'telegram', type: 'private', ownerId: 'owner', name: '示例' }, 0).identity.ownerKey).toBe('owner')
})
test('normalization retains a parser-supplied source group identity', () => {
  expect(conversation('qq-shuakami', {}, { platform: 'qq', type: 'group', ownerId: 'owner', groupId: 'group', name: '示例' }, 0).identity.conversationKey).toBe('group')
})
test('fallback deduplication keeps different attachments and quoted text at the same timestamp', async () => {
  async function media(id: string, locator: string, quote: string) {
    const c = candidate(id), v = records(c, [1]), read = v.messages
    v.messages = function* () { for (const r of read()) yield { ...r, message: { ...r.message,
      kind: 'reply' as const, reply: { originalId: null, idNamespace: null, text: quote, senderName: '示例', sentAtMs: null },
      attachments: [{ kind: 'image' as const, locator, name: null, state: 'unresolved' as const }] } } }
    const t = await resolveAutoTarget(store, c, () => v.messages()); if (t.status !== 'matched') throw Error('target')
    return commitConversation(store, v, t.target, new AbortController().signal)
  }
  await media('a','first.png','第一段引用')
  expect(await media('b','second.png','第一段引用')).toMatchObject({inserted:1,duplicates:0})
  expect(await media('c','first.png','另一段引用')).toMatchObject({inserted:1,duplicates:0})
  expect(await media('d','first.png','第一段引用')).toMatchObject({inserted:0,duplicates:1})
})
test('a large incoming stream yields to cancellation before consuming the whole source',async()=>{
  const c=unknown('large'),v=records(c,[1]),sample=[...v.messages()][0],controller=new AbortController()
  let seen=0
  setImmediate(()=>controller.abort())
  await expect(Promise.resolve(resolveAutoTarget(store,c,function*(){
    for(let index=0;index<100000;index++) {seen++;yield {...sample,message:{...sample.message,ordinal:index,text:`large-${index}`}}}
  },controller.signal))).rejects.toThrow('CANCELLED')
  expect(seen).toBeLessThan(100000)
})
test('overlapping files in one target group preserve the largest per-file occurrence count',async()=>{
  const a=candidate('a'),b=candidate('b'),first=records(a,[1,1]),second=records(b,[1,1,1])
  const group={...first,candidates:[a,b],candidateIds:['a','b'],sources:[...first.sources,...second.sources],
    *messages(){yield* first.messages();yield* second.messages()}}
  const t=resolveTarget(store,a);if(t.status!=='matched')throw Error('target')
  expect(await commitConversation(store,group,t.target,new AbortController().signal)).toMatchObject({inserted:3,duplicates:2})
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:3n})
})
