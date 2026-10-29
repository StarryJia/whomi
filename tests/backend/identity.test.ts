import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore, type Store } from '../../electron/data/db/open'
import { classifyMessage, classifyBatch, confirmSelf, messageKeyNamespace, resolveTarget, type ResolvedTarget } from '../../electron/data/import/identity'
import type { Candidate, TargetDecision } from '../../src/shared/import-contract'
import { normalizeModel } from '../../src/shared/conversation-model'
import { message, temporaryStore } from './helpers'

// All accounts, titles and records in this file are fictional.
let store: Store, temp: ReturnType<typeof temporaryStore>
beforeEach(() => { temp = temporaryStore(); store = openStore(temp.path) })
afterEach(() => { store.close(); temp.cleanup() })
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({ candidateId: 'candidate', entryId: 'entry', title: '小林', formatId: 'test', parserVersion: '1', sourceKey: 'chat', kind: 'direct', identity: { platform: 'p', ownerKey: 'owner', conversationKey: 'chat', namespace: 'test' }, members: [], fingerprint: 'file-a', counts: { seen: 0, validRecords: 0, invalidRecords: 0 }, status: 'staged', issues: [], ...overrides })
const origin = (fingerprint = 'file-a', ordinal = 0) => ({ fingerprint, sourceConversationKey: 'chat', ordinal })
const parsed = (overrides = {}) => normalizeModel(message(overrides))
const decision = (conversationId = '1'): TargetDecision => ({ candidateId: 'candidate', target: { kind: 'existing', conversationId }, confirmedAliases: [] })
function target(c = candidate(), d?: TargetDecision): ResolvedTarget {
  const resolution = resolveTarget(store, c, d)
  expect(resolution.status).toBe('matched')
  if (resolution.status !== 'matched') throw new Error('Expected a target')
  return resolution.target
}
function existing() {
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'小林','direct',0); INSERT INTO source_conversations(id,conversation_id,platform,owner_key,conversation_key,namespace) VALUES (1,1,'p','owner','chat','test'); INSERT INTO import_jobs(id,status,created_at_ms) VALUES (1,'completed',0); INSERT INTO import_results(id,job_id,candidate_id,conversation_id,status,committed_at_ms) VALUES (1,1,'old',1,'committed',0)")
}
function saved(t: ResolvedTarget, id: string | null = 'm2', fingerprint = 'file-a', ordinal = 0) {
  const key = messageKeyNamespace(t, 'message')
  const local = store.writer.prepare("INSERT INTO messages(conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES (1,'unknown','原名称','text','原正文',?)").run(ordinal).lastInsertRowid
  if (id) store.writer.prepare('INSERT INTO message_keys VALUES (?,?,?,?)').run(1n, key, id, local)
  store.writer.prepare("INSERT INTO message_origins(message_id,conversation_id,import_result_id,file_fingerprint,source_conversation_key,ordinal,parser_id,parser_version) VALUES (?,1,1,?,'chat',?,'test','1')").run(local, fingerprint, ordinal)
  store.writer.prepare("INSERT INTO message_attachments(message_id,kind,state) VALUES (?,'image','missing')").run(local)
  store.writer.prepare("INSERT INTO message_replies(message_id,conversation_id,text) VALUES (?,1,'原引用')").run(local)
}

test('never uses titles or suffixes as reliable identities and keeps new targets provisional', () => {
  const first = target(candidate({ identity: { platform: 'p', ownerKey: null, conversationKey: null, namespace: 'test' } }))
  expect(first.kind).toBe('new')
  expect(store.reader.prepare('SELECT count(*) AS n FROM conversations').get()).toEqual({ n: 0n })
  existing()
  expect(resolveTarget(store, candidate({ identity: { platform: 'p', ownerKey: null, conversationKey: null, namespace: 'test' } })).status).toBe('needs-choice')
  expect(resolveTarget(store, candidate({ identity: { platform: 'p', ownerKey: 'owner_suffix', conversationKey: 'chat', namespace: 'test' } })).status).toBe('matched')
  expect(target(candidate({ identity: { platform: 'p', ownerKey: 'owner_suffix', conversationKey: 'chat', namespace: 'test' } })).kind).toBe('new')
})
test('reuses exact reliable mappings; validates decisions, ownership and canonical decimal ids', () => {
  existing()
  expect(target().conversationId).toBe('1')
  for (const id of ['01', '1e0', '0', '-1', '9223372036854775808', '2']) expect(resolveTarget(store, candidate(), decision(id)).status).toBe('blocked')
  expect(resolveTarget(store, candidate(), { ...decision(), candidateId: 'other' }).status).toBe('blocked')
  expect(resolveTarget(store, candidate(), { ...decision(), target: { kind: 'new' } }).status).toBe('blocked')
  const other = candidate({ identity: { ...candidate().identity, conversationKey: 'other' } })
  expect(resolveTarget(store, other, decision()).status).toBe('blocked')
  const unknown = candidate({ identity: { platform: 'p', ownerKey: null, conversationKey: null, namespace: 'test' } })
  expect(target(unknown, decision()).conversationId).toBe('1')
  for (const aliases of [null, undefined, 'invalid']) expect(resolveTarget(store, candidate(), { ...decision(), confirmedAliases: aliases } as never).status).toBe('blocked')
})
test('skips stable scoped keys without changing original content, origins, attachments or replies', () => {
  existing(); const t = target(); saved(t)
  const before = store.reader.prepare('SELECT * FROM messages').all()
  expect(classifyMessage(store, t, parsed({ originalId: 'm2', idNamespace: 'message', text: '改过的正文' }), origin('file-b'))).toBe('duplicate')
  expect(store.reader.prepare('SELECT * FROM messages').all()).toEqual(before)
  expect(store.reader.prepare('SELECT count(*) AS n FROM message_origins').get()).toEqual({ n: 1n })
  expect(store.reader.prepare('SELECT text FROM message_replies').get()).toEqual({ text: '原引用' })
  expect(store.reader.prepare('SELECT state FROM message_attachments').get()).toEqual({ state: 'missing' })
  const unknown = target(candidate({ identity: { platform: 'p', ownerKey: null, conversationKey: null, namespace: 'test' } }), decision())
  expect(classifyMessage(store, unknown, parsed({ originalId: 'm2', idNamespace: 'message' }), origin('file-b'))).toBe('duplicate')
  expect(classifyMessage(store, t, parsed({ originalId: 'm2', idNamespace: 'other-message' }), origin('file-b'))).toBe('new')
  const other = target(candidate({ identity: { ...candidate().identity, conversationKey: 'other' } }))
  expect(classifyMessage(store, other, parsed({ originalId: 'm2', idNamespace: 'message' }), origin())).toBe('new')
})
test('preserves independent no-id records initially; identical origin repeats skip; other files are ambiguous', () => {
  const fresh = target()
  expect(classifyBatch(store, fresh, [{ message: parsed(), origin: origin() }, { message: parsed({ ordinal: 1 }), origin: origin('file-a', 1) }])).toEqual(['new', 'new'])
  existing(); const t = target(); saved(t, null)
  expect(classifyMessage(store, t, parsed(), origin())).toBe('duplicate')
  expect(classifyMessage(store, t, parsed({ ordinal: 1 }), origin('file-a', 1))).toBe('new')
  expect(classifyMessage(store, t, parsed(), origin('file-b'))).toBe('ambiguous')
  const unknown = target(candidate({ identity: { platform: 'p', ownerKey: null, conversationKey: null, namespace: 'test' } }), decision())
  expect(classifyMessage(store, unknown, parsed({ originalId: 'm2', idNamespace: 'message' }), origin('file-b'))).toBe('new')
})
test('keeps the first valid batch key and rejects invalid records instead of treating them as duplicates', () => {
  const t = target(), m = parsed({ originalId: 'm2', idNamespace: 'message' })
  expect(classifyBatch(store, t, [{ message: m, origin: origin() }, { message: { ...m, ordinal: 1, text: 'different' }, origin: origin('file-a', 1) }])).toEqual(['new', 'duplicate'])
  expect(() => classifyBatch(store, t, [{ message: m, origin: origin() }, { message: { ...m, ordinal: 1, text: 7 } as never, origin: origin('file-a', 1) }])).toThrow()
  expect(() => classifyMessage(store, { ...t }, m, origin())).toThrow()
  expect(() => classifyMessage(store, t, m, origin('file-a', 2))).toThrow()
})
function selfFixture() {
  existing()
  store.writer.exec("INSERT INTO accounts(id,platform,stable_account_key) VALUES (1,'p','owner'),(2,'p','other'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name,account_id,self_hint) VALUES (1,1,1,'owner','小林',1,1),(2,1,1,'other','小林',2,0)")
  confirmSelf(store, '1', '1')
}
test('keeps hints separate, reuses only conflict-free explicitly confirmed accounts and never strips suffixes', () => {
  selfFixture()
  const members = [{ sourceKey: 'sender', displayName: '小林', stableAccountKey: 'owner', selfHint: true }]
  expect(target(candidate({ members })).confirmedSelf).toBe('sender')
  expect(target(candidate({ members: [{ ...members[0], stableAccountKey: 'owner_suffix' }] })).confirmedSelf).toBeNull()
  expect(target(candidate({ members: [...members, { sourceKey: 'other', displayName: '小林', stableAccountKey: 'other', selfHint: true }] })).confirmedSelf).toBeNull()
  expect(target(candidate({ members: [{ ...members[0], selfHint: false }] })).confirmedSelf).toBeNull()
})
test('validates explicit platform aliases without writes and refuses account collisions', () => {
  selfFixture()
  const c = candidate({ identity: { ...candidate().identity, ownerKey: 'owner_suffix' }, members: [{ sourceKey: 'sender', displayName: '小林', stableAccountKey: 'owner_suffix', selfHint: true }] })
  const aliases = [{ platform: 'p', aliasKey: 'owner_suffix', accountKey: 'owner' }]
  expect(target(c, { ...decision(), confirmedAliases: aliases }).confirmedSelf).toBe('sender')
  expect(store.reader.prepare('SELECT count(*) AS n FROM account_aliases').get()).toEqual({ n: 0n })
  for (const bad of [[{ ...aliases[0], platform: 'q' }], [{ platform: 'p', aliasKey: 'other', accountKey: 'owner' }]]) expect(resolveTarget(store, c, { ...decision(), confirmedAliases: bad }).status).toBe('blocked')
  store.writer.exec("INSERT INTO account_aliases(platform,alias_key,account_id,source) VALUES ('p','owner_suffix',2,'user')")
  expect(resolveTarget(store, c, { ...decision(), confirmedAliases: aliases }).status).toBe('blocked')
})
test('reuses persisted aliases and refuses two pending aliases that join distinct stored accounts', () => {
  selfFixture()
  store.writer.exec("INSERT INTO account_aliases(platform,alias_key,account_id,source) VALUES ('p','owner_suffix',1,'user')")
  const c = candidate({ identity: { ...candidate().identity, ownerKey: 'owner_suffix' }, members: [{ sourceKey: 'sender', displayName: '小林', stableAccountKey: 'owner_suffix', selfHint: null }] })
  expect(target(c).conversationId).toBe('1')
  expect(target(c).confirmedSelf).toBe('sender')
  expect(resolveTarget(store, c, { ...decision(), confirmedAliases: [{ platform: 'p', aliasKey: 'owner_suffix', accountKey: 'other' }] }).status).toBe('blocked')
  expect(resolveTarget(store, c, { ...decision(), confirmedAliases: [{ platform: 'p', aliasKey: 'owner_suffix', accountKey: 'owner' }, { platform: 'p', aliasKey: 'owner', accountKey: 'owner_suffix' }] }).status).toBe('blocked')
})
test('accepts an explicit owner alias to an existing source even before that owner has a membership', () => {
  existing()
  const c = candidate({ identity: { ...candidate().identity, ownerKey: 'owner_suffix' } })
  expect(target(c, { ...decision(), confirmedAliases: [{ platform: 'p', aliasKey: 'owner_suffix', accountKey: 'owner' }] }).conversationId).toBe('1')
  expect(store.reader.prepare('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0n })
})
test('keeps parser-only hints unconfirmed and does not restore explicitly revoked self from another conversation', () => {
  const members = [{ sourceKey: 'sender', displayName: '小林', stableAccountKey: 'owner', selfHint: true }]
  expect(target(candidate({ members })).confirmedSelf).toBeNull()
  selfFixture()
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (2,'other','direct',0); INSERT INTO source_conversations(id,conversation_id,platform,owner_key,conversation_key,namespace) VALUES (2,2,'p','owner','other','test'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name,account_id) VALUES (3,2,2,'owner','小林',1)")
  confirmSelf(store, '2', '3'); confirmSelf(store, '1', null)
  expect(target(candidate({ members })).confirmedSelf).toBeNull()
  confirmSelf(store, '1', '2')
  expect(target(candidate({ members })).confirmedSelf).toBeNull()
})
test('classifies no-id new files conservatively in a batch and sees current transaction keys', () => {
  const t = target()
  expect(classifyBatch(store, t, [{ message: parsed(), origin: origin() }, { message: parsed({ ordinal: 1 }), origin: origin('file-b', 1) }])).toEqual(['new', 'ambiguous'])
  existing(); const e = target()
  store.writer.transaction(() => {
    saved(e)
    expect(classifyMessage(store, e, parsed({ originalId: 'm2', idNamespace: 'message' }), origin('file-b'))).toBe('duplicate')
    expect(store.reader.prepare('SELECT count(*) AS n FROM message_keys').get()).toEqual({ n: 0n })
  })()
})
test('confirms only an owned member, supports large ids and revocation leaves names/hints/content unchanged', () => {
  selfFixture()
  expect(() => confirmSelf(store, '1', '999')).toThrow()
  expect(() => confirmSelf(store, '01', null)).toThrow()
  confirmSelf(store, '1', null)
  expect(store.reader.prepare("SELECT count(*) AS n FROM self_confirmations WHERE status='confirmed'").get()).toEqual({ n: 0n })
  expect(store.reader.prepare('SELECT display_name,self_hint FROM memberships WHERE id=1').get()).toEqual({ display_name: '小林', self_hint: 1n })
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (9007199254740993,'large','direct',0); INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES (9007199254740993,9007199254740993,'p','test'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES (9007199254740993,9007199254740993,9007199254740993,'large','large')")
  confirmSelf(store, '9007199254740993', '9007199254740993')
  expect(target(candidate({ identity: { platform: 'p', ownerKey: null, conversationKey: null, namespace: 'test' } }), decision('9007199254740993')).conversationId).toBe('9007199254740993')
  expect(() => confirmSelf(store, '1', '9007199254740993')).toThrow()
  expect(store.reader.prepare("SELECT member_id FROM self_confirmations WHERE conversation_id=9007199254740993 AND status='confirmed'").get()).toEqual({ member_id: 9007199254740993n })
})
