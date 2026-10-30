import { beforeEach, afterEach, expect, test } from 'vitest'
import { openStore, type Store } from '../../electron/data/db/open'
import { commitConversation, createCommitter } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { rebuildSummary } from '../../electron/data/import/summary'
import { temporaryStore } from './helpers'
import { candidate, view } from './import-fixture'
let store: Store, temp: ReturnType<typeof temporaryStore>
beforeEach(() => { temp = temporaryStore(); store = openStore(temp.path) })
afterEach(() => { store.close(); temp.cleanup() })
function job() { return store.writer.prepare("INSERT INTO import_jobs(status,created_at_ms) VALUES ('running',0)").run().lastInsertRowid.toString() }
function target(c = candidate()) { const r = resolveTarget(store, c); if (r.status !== 'matched') throw Error('target'); return r.target }
const signal = () => new AbortController().signal
test('inserts m1/m2/m3 then m2/m4 without changing any saved message data', async () => {
  await commitConversation(store, view(job(), [candidate()], [['m1', 'm2', 'm3']]), target(), signal())
  const m2 = (store.reader.prepare("SELECT m.* FROM messages m JOIN message_keys k ON k.message_id=m.id WHERE original_id='m2'").get() as {id:bigint})
  store.writer.prepare("INSERT INTO message_attachments(message_id,kind,state) VALUES (?,'image','missing')").run(m2.id)
  store.writer.prepare("INSERT INTO message_replies(message_id,conversation_id,text) VALUES (?,1,'原引用')").run(m2.id)
  const before = ['messages', 'message_origins', 'message_attachments', 'message_replies'].map(t => store.reader.prepare(`SELECT * FROM ${t} WHERE ${t === 'messages' ? 'id' : 'message_id'}=?`).all(m2.id))
  const result = await commitConversation(store, view(job(), [candidate('b')], [['m2', 'm4']]), target(candidate('b')), signal())
  expect(result.inserted).toBe(1); expect(result.duplicates).toBe(1)
  expect(store.reader.prepare('SELECT original_id FROM message_keys ORDER BY original_id').all()).toEqual(['m1','m2','m3','m4'].map(original_id => ({original_id})))
  expect(['messages', 'message_origins', 'message_attachments', 'message_replies'].map(t => store.reader.prepare(`SELECT * FROM ${t} WHERE ${t === 'messages' ? 'id' : 'message_id'}=?`).all(m2.id))).toEqual(before)
})
test('rolls 300 tentative inserts back while retaining 10000 old rows', async () => {
  await commitConversation(store, view(job(), [candidate()], [Array.from({length:10000}, (_,i) => `m${i}`)]), target(), signal())
  const merge = createCommitter({ afterInsert(n) { if (n === 300) throw Error('injected') } })
  await expect(merge(store, view(job(), [candidate('b')], [Array.from({length:500}, (_,i) => `n${i}`)]), target(candidate('b')), signal())).rejects.toThrow('injected')
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:10000n})
})

test('an actual SQLite full error rolls the current transaction back and preserves committed messages', async () => {
  await commitConversation(store, view(job(), [candidate()], [['old']]), target(), signal())
  const staged = view(job(), [candidate('full')], [Array.from({ length: 501 }, (_, i) => `new${i}`)])
  const messages = staged.messages
  staged.messages = function* () { for (const record of messages()) yield { ...record, message: { ...record.message, text: 'x'.repeat(50000) } } }
  const commit = createCommitter({ afterInsert(count) {
    if (count === 300) {
      const pages = Number(store.writer.pragma('page_count', { simple: true }))
      store.writer.pragma(`max_page_count=${pages}`)
    }
  } })
  try {
    await expect(commit(store, staged, target(candidate('full')), signal())).rejects.toMatchObject({ code: 'SQLITE_FULL' })
  } finally { store.writer.pragma('max_page_count=4294967294') }
  expect(store.reader.prepare('SELECT text FROM messages').all()).toEqual([{ text: 'old' }])
  expect(store.writer.pragma('integrity_check', { simple: true })).toBe('ok')
})
test('rolls both files of a target back, and reader never sees uncommitted rows', async () => {
  let checks = 0
  const merge = createCommitter({ afterInsert(n) { expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0n}); checks++; if(n === 2) throw Error('second file') } })
  await expect(merge(store, view(job(), [candidate('a'),candidate('b')], [['m1'],['m2']]), target(), signal())).rejects.toThrow('second file')
  expect(checks).toBe(2); expect(store.reader.prepare('SELECT count(*) n FROM conversations').get()).toEqual({n:0n})
})
test('resolves only new replies after later messages and persists duplicate-only results', async () => {
  const staged = view(job(), [candidate()], [['m1','m2']]), read = staged.messages
  staged.messages = function* () { for (const r of read()) { if (r.message.originalId === 'm1') r.message.reply = { originalId:'m2',idNamespace:'test',text:'later',senderName:null,sentAtMs:null }; yield r } }
  await commitConversation(store, staged, target(), signal())
  expect(store.reader.prepare('SELECT state FROM message_replies').get()).toEqual({state:'resolved'})
  const result = await commitConversation(store, view(job(), [candidate('b')], [['m1','m2']]), target(candidate('b')), signal())
  expect(result.inserted).toBe(0)
  expect(store.reader.prepare("SELECT phase FROM import_results ORDER BY id DESC LIMIT 1").get()).toEqual({phase:'duplicate'})
})

test('validates explicit staged self selection and persists optout or selected member atomically',async()=> {
  const c=candidate();c.members=[{sourceKey:'sender',displayName:'示例本人',stableAccountKey:'owner',selfHint:true}]
  const v=view(job(),[c],[['m1']]);v.decisions=[{candidateId:'a',target:{kind:'new'},confirmedAliases:[],selfMemberKey:'sender'}]
  const r=resolveTarget(store,c,v.decisions[0]);if(r.status!=='matched')throw Error('target')
  await commitConversation(store,v,r.target,signal())
  expect(store.reader.prepare("SELECT status,source FROM self_confirmations WHERE status='confirmed'").get()).toEqual({status:'confirmed',source:'user'})
  const next=candidate('b');const second=view(job(),[next],[['m1']]);second.decisions=[{candidateId:'b',target:{kind:'existing',conversationId:'1'},confirmedAliases:[],selfMemberKey:null}]
  const t=resolveTarget(store,next,second.decisions[0]);if(t.status!=='matched')throw Error('target')
  await commitConversation(store,second,t.target,signal())
  expect(store.reader.prepare('SELECT conversation_id FROM self_opt_outs').all()).toEqual([{conversation_id:1n}])
  expect(store.reader.prepare("SELECT 1 FROM self_confirmations WHERE status='confirmed'").get()).toBeUndefined()
  expect(resolveTarget(store,c,{candidateId:'a',target:{kind:'existing',conversationId:'1'},confirmedAliases:[],selfMemberKey:'missing'}).status).toBe('blocked')
})
test('conflicting explicit self choices roll the whole target group back',async()=> {
  const a=candidate(),b=candidate('b');a.members=[{sourceKey:'sender',displayName:'示例',stableAccountKey:'owner',selfHint:null}]
  const v=view(job(),[a,b],[['m1'],['m2']]);v.decisions=[{candidateId:'a',target:{kind:'new'},confirmedAliases:[],selfMemberKey:'sender'},{candidateId:'b',target:{kind:'new'},confirmedAliases:[],selfMemberKey:null}]
  const r=resolveTarget(store,a,v.decisions[0]);if(r.status!=='matched')throw Error('target')
  await expect(commitConversation(store,v,r.target,signal())).rejects.toThrow('SELF_CONFLICT')
  expect(store.reader.prepare('SELECT count(*) n FROM conversations').get()).toEqual({n:0n})
})
test('preserves unidentifiable cross-file records and skips same-file no-id repeats',async()=> {
  const c=candidate();const v=view(job(),[c],[['m1']]),messages=v.messages
  v.messages=function*(){for(const r of messages()){r.message.originalId=null;r.message.idNamespace=null;yield r}}
  await commitConversation(store,v,target(),signal())
  const same=candidate('b','chat','a'),repeat=view(job(),[same],[['m1']]);repeat.messages=v.messages
  // Preserve the candidate binding while replaying its identical origin.
  repeat.messages=function*(){for(const r of v.messages())yield {...r,candidateId:'b'}}
  expect(await commitConversation(store,repeat,target(same),signal())).toMatchObject({inserted:0,duplicates:1})
  const other=candidate('c'),cross=view(job(),[other],[['m2']]);cross.messages=function*(){for(const r of v.messages())yield {...r,candidateId:'c',origin:{...r.origin,fingerprint:'other'}}}
  expect(await commitConversation(store,cross,target(other),signal())).toMatchObject({inserted:1,duplicates:0})
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:2n})
})
test('yields before the next record exceeds an eight MiB batch',async()=> {
  const controller=new AbortController(),c=candidate(),v=view(job(),[c],[['m1','m2']]),read=v.messages
  v.messages=function*(){for(const r of read()){r.message.text='x'.repeat(5*1024**2);yield r}}
  let written=0
  const merge=createCommitter({afterInsert(n){written=n;if(n===1)setImmediate(()=>controller.abort())}})
  await expect(merge(store,v,target(c),controller.signal)).rejects.toThrow('CANCELLED')
  expect(written).toBe(1)
})
test('marks summary pending in the same duplicate-only transaction when explicit self adds a member',async()=> {
  const c=candidate();c.members=[{sourceKey:'sender',displayName:'示例发送者',stableAccountKey:'sender',selfHint:null},{sourceKey:'silent-owner',displayName:'示例本人',stableAccountKey:'owner',selfHint:null}]
  const first=view(job(),[c],[['m1']]),read=first.messages
  first.messages=function*(){for(const r of read()){r.message.senderKind='member';r.message.senderKey='sender';yield r}}
  await commitConversation(store,first,target(c),signal());await rebuildSummary(store,'1')
  const before=store.reader.prepare('SELECT * FROM messages').all()
  const second=view(job(),[c],[['m1']]);second.decisions=[{candidateId:c.candidateId,target:{kind:'existing',conversationId:'1'},confirmedAliases:[],selfMemberKey:'silent-owner'}]
  const t=resolveTarget(store,c,second.decisions[0]);if(t.status!=='matched')throw Error('target')
  const result=await commitConversation(store,second,t.target,signal())
  expect(result).toMatchObject({inserted:0,duplicates:1,summaryChanged:true})
  expect(store.reader.prepare('SELECT status FROM conversation_summaries').get()).toEqual({status:'pending'})
  expect(store.reader.prepare('SELECT count(*) n FROM memberships').get()).toEqual({n:2n})
  expect(store.reader.prepare('SELECT * FROM messages').all()).toEqual(before)
})
test('reports processed records during a transaction without exposing them as committed messages',async()=> {
  const progress:number[]=[]
  const merge=createCommitter({progress(processed) {
    progress.push(processed)
    if(processed===500)expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0n})
  }})
  await merge(store,view(job(),[candidate()],[Array.from({length:1001},(_,i)=>`m${i}`)]),target(),signal())
  expect(progress).toContain(500)
  expect(progress.at(-1)).toBe(1001)
})
