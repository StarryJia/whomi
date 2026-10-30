import { beforeEach,afterEach,expect,test } from 'vitest'
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDataService } from '../../electron/data/service'
import { openStore,type Store } from '../../electron/data/db/open'
import { createCommitter } from '../../electron/data/import/merge'
import { ImportFailure } from '../../electron/data/import/limits'
import type { ParserAdapter } from '../../electron/data/parsers/types'
import { normalizeModel } from '../../src/shared/conversation-model'
import { candidate } from './import-fixture'
import { message } from './helpers'
let directory:string,store:Store
beforeEach(async()=> {directory=await mkdtemp(join(tmpdir(),'whomi-runner-'));store=openStore(join(directory,'formal.sqlite'))})
afterEach(async()=> {store.close();await rm(directory,{recursive:true,force:true})})
const parser:ParserAdapter={id:'test',version:'1',mode:'bounded',extensions:['.json'],capabilities:{multiConversation:false,stableMessageIds:'platform',media:'descriptors-only'},async detect(){return 1},async *parse(input) {
  const payload=JSON.parse(await readFile(input.entry,'utf8')) as {key:string;ids:string[];blocked?:boolean;noId?:boolean;selfMember?:boolean}
  const c=candidate('a',payload.key)
  yield {type:'conversation',value:{sourceKey:c.sourceKey,title:c.title,kind:c.kind,identity:c.identity}}
  if(payload.selfMember) yield {type:'member',conversationKey:c.sourceKey,value:{sourceKey:'silent-owner',displayName:'示例本人',stableAccountKey:'owner',selfHint:null}}
  for(const [ordinal,id] of payload.ids.entries()) yield {type:'message',value:normalizeModel(message({conversationKey:c.sourceKey,ordinal,originalId:payload.noId ? null:id,idNamespace:payload.noId ? null:'test',text:id}))}
  if(payload.blocked) yield {type:'issue',value:{code:'BAD',severity:'blocking',candidateId:'',action:'请检查文件。'}}
  yield {type:'end',conversationKey:c.sourceKey,seen:payload.ids.length}
}}
async function setup(files:{key:string;ids:string[];blocked?:boolean;noId?:boolean;selfMember?:boolean}[],runner:Parameters<typeof createDataService>[0]['runner']={}) {
  const grants=[]
  for(const [i,payload] of files.entries()){const path=join(directory,`${i}.json`);await writeFile(path,JSON.stringify(payload));grants.push({rootPath:path})}
  const service=createDataService({store,appDataDirectory:directory,staging:{parsers:[parser]},runner})
  const id=await service.prepareImport(grants),d=await service.getImport(id)
  await service.startImport({kind:'stage',jobId:id,entryIds:d.discovery!.entries.map(e=>e.entryId)});await service.idle()
  return {service,id}
}
test('keeps one job from discovery through staging and rejects a second task',async()=> {
  const {service,id}=await setup([{key:'a',ids:['m1']}])
  expect((await service.getImport(id)).status).toBe('awaiting_commit')
  await expect(service.prepareImport([])).rejects.toThrow('IMPORT_BUSY')
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  expect(await service.getImport(id)).toMatchObject({status:'completed',inserted:1})
  expect(store.reader.prepare('SELECT count(*) n FROM import_jobs').get()).toEqual({n:1n})
})
test('A saved B failed C duplicate reports partial completion',async()=> {
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'C','direct',0);INSERT INTO source_conversations(conversation_id,platform,owner_key,conversation_key,namespace) VALUES (1,'p','owner','c','test');INSERT INTO messages(id,conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES (1,1,'unknown','','text','old',0);INSERT INTO message_keys VALUES (1,'test','m3',1)")
  const commit=createCommitter()
  const {service,id}=await setup([{key:'a',ids:['m1']},{key:'b',ids:['m2']},{key:'c',ids:['m3']}],{commit:async(s,v,t,signal)=> {if(t.sourceKey==='b') throw Error('invalid');return commit(s,v,t,signal)}})
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  expect((await service.getImport(id)).results.map(r=>r.status)).toEqual(['saved','failed','duplicate'])
  expect((await service.getImport(id)).status).toBe('partially_completed')
})
test('groups two files atomically and blocks a known target when any file is blocked',async()=> {
  const {service,id}=await setup([{key:'a',ids:['m1']},{key:'a',ids:['m2'],blocked:true},{key:'c',ids:['m3']}])
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  expect((await service.getImport(id)).results.map(r=>r.status)).toEqual(['blocked','blocked','saved'])
  expect(store.reader.prepare('SELECT text FROM messages').all()).toEqual([{text:'m3'}])
})
test('stops later groups on storage failure and keeps already saved data',async()=> {
  const {service,id}=await setup([{key:'a',ids:['m1']},{key:'b',ids:['m2']},{key:'c',ids:['m3']}],{commit:async(s,v,t,signal)=>{if(t.sourceKey==='b')throw new ImportFailure('DISK_SPACE');return createCommitter()(s,v,t,signal)}})
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  expect(await service.getImport(id)).toMatchObject({status:'partially_completed',inserted:1})
  expect(store.reader.prepare('SELECT text FROM messages').all()).toEqual([{text:'m1'}])
})
test('summary failure keeps saved result and can retry separately',async()=> {
  const {service,id}=await setup([{key:'a',ids:['m1']}],{summary:async()=>{throw Error('summary')}})
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  let result=(await service.getImport(id)).results[0]
  expect(result).toMatchObject({status:'saved',summaryFailed:true})
  await service.retrySummary(result.conversationId!);result=(await service.getImport(id)).results[0]
  expect(result.summaryFailed).toBe(false)
})
test('a summary storage failure does not count committed records twice',async()=> {
  const progress:number[]=[]
  const {service,id}=await setup([{key:'a',ids:['m1']}],{summary:async()=>{throw new ImportFailure('DISK_SPACE')},progress:count=>progress.push(count)})
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  expect((await service.getImport(id)).results[0]).toMatchObject({status:'saved',inserted:1})
  expect(progress.at(-1)).toBe(1)
})
test.each([1,2])('cancellation during group %i rolls current group back and preserves prior commits',async groupNumber=> {
  let service:ReturnType<typeof createDataService>,id:string,groups=0
  const prepared=await setup([{key:'a',ids:Array.from({length:501},(_,i)=>`m${i}`)},{key:'b',ids:Array.from({length:501},(_,i)=>`n${i}`)}],{commit:async(s,v,t,signal)=> {
    groups++;const merge=createCommitter({afterInsert(n){if(groups===groupNumber && n===1) setImmediate(()=>{void service.cancelImport(id)})}})
    return merge(s,v,t,signal)
  }});service=prepared.service;id=prepared.id
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:groupNumber===1 ? 0n:501n})
  expect((await service.getImport(id)).status).toBe(groupNumber===1 ? 'cancelled':'partially_completed')
})
test('self confirmation uses the same writer queue and runs after rollback',async()=> {
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'original','direct',0)")
  let pending:Promise<void>|undefined,service:ReturnType<typeof createDataService>
  const prepared=await setup([{key:'a',ids:Array.from({length:501},(_,i)=>`m${i}`)}],{commit:createCommitter({afterInsert(n){if(n===1)pending=service.confirmSelf('1',null);if(n===501)throw Error('rollback')}})})
  service=prepared.service
  await service.startImport({kind:'commit',plan:{jobId:prepared.id,decisions:[]}});await service.idle();await pending
  expect(store.reader.prepare('SELECT conversation_id FROM self_opt_outs').all()).toEqual([{conversation_id:1n}])
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0n})
})
test('prevents simultaneous prepare requests from creating two jobs',async()=> {
  const service=createDataService({store,appDataDirectory:directory})
  const result=await Promise.allSettled([service.prepareImport([]),service.prepareImport([])])
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(store.reader.prepare('SELECT count(*) n FROM import_jobs').get()).toEqual({n:1n})
})
test.each([true,false])('blocks every file targeting A when a file has an invalid explicit choice, parser blocked=%s',async blocked=> {
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'A','direct',0);INSERT INTO source_conversations(conversation_id,platform,owner_key,conversation_key,namespace) VALUES (1,'p','owner','a','test')")
  const {service,id}=await setup([{key:'a',ids:['m1']},{key:'a',ids:['m2'],blocked}])
  const c=(await service.getImport(id)).candidates[1]
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[{candidateId:c.candidateId,target:{kind:'new'},confirmedAliases:[]}]}});await service.idle()
  expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0n})
  expect((await service.getImport(id)).results.map(r=>r.status)).toEqual(['blocked','blocked'])
})
test('rebuilds member summary after duplicate-only explicit self selection',async()=> {
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'A','direct',0);INSERT INTO source_conversations(id,conversation_id,platform,owner_key,conversation_key,namespace) VALUES (1,1,'p','owner','a','test');INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES (1,1,1,'sender','示例发送者');INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES (1,1,1,'member','示例发送者','text','old',0);INSERT INTO message_keys VALUES (1,'test','m1',1);INSERT INTO conversation_summaries(conversation_id,message_count,member_count,status) VALUES (1,1,1,'ready')")
  const before=store.reader.prepare('SELECT * FROM messages').all()
  const {service,id}=await setup([{key:'a',ids:['m1'],selfMember:true}])
  const c=(await service.getImport(id)).candidates[0]
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[{candidateId:c.candidateId,target:{kind:'existing',conversationId:'1'},confirmedAliases:[],selfMemberKey:'silent-owner'}]}});await service.idle()
  expect((await service.getImport(id)).results[0]).toMatchObject({status:'duplicate',inserted:0,duplicates:1})
  expect(store.reader.prepare('SELECT count(*) n FROM memberships').get()).toEqual({n:2n})
  expect(store.reader.prepare('SELECT member_count,status FROM conversation_summaries').get()).toEqual({member_count:2n,status:'ready'})
  expect(store.reader.prepare('SELECT * FROM messages').all()).toEqual(before)
})
test('delivers the latest fast staging state through a trailing throttled notification',async()=> {
  const events:{state:string;at:number}[]=[],path=join(directory,'fast.json')
  await writeFile(path,JSON.stringify({key:'a',ids:['m1']}))
  const service=createDataService({store,appDataDirectory:directory,staging:{parsers:[parser]},changed:s=>events.push({state:s.status,at:Date.now()})})
  const id=await service.prepareImport([{rootPath:path}]),snapshot=await service.getImport(id)
  try {
    await service.startImport({kind:'stage',jobId:id,entryIds:snapshot.discovery!.entries.map(e=>e.entryId)});await service.idle()
    await new Promise(r=>setTimeout(r,250))
    expect(events.at(-1)?.state).toBe('awaiting_commit')
    for(let i=1;i<events.length;i++)expect(events[i].at-events[i-1].at).toBeGreaterThanOrEqual(190)
  }finally {await service.cancelImport(id)}
  expect(events.at(-1)?.state).toBe('cancelled')
})

test('publishes real parsed counts before staging finishes',async()=> {
  const events:{state:string;seen:number}[]=[],path=join(directory,'progress.json')
  await writeFile(path,JSON.stringify({key:'progress',ids:Array.from({length:1000},(_,i)=>`m${i}`)}))
  const service=createDataService({store,appDataDirectory:directory,staging:{parsers:[parser],onProgress:(_id,counts)=>events.push({state:'parsing',seen:counts.seen})}})
  const id=await service.prepareImport([{rootPath:path}]),snapshot=await service.getImport(id)
  try {
    await service.startImport({kind:'stage',jobId:id,entryIds:snapshot.discovery!.entries.map(e=>e.entryId)});await service.idle()
    expect(events.some(event=>event.seen>0 && event.seen<1000)).toBe(true)
    expect(events.at(-1)?.seen).toBe(1000)
  }finally {await service.cancelImport(id)}
})
test('blocked parsing keeps its original diagnostic instead of requesting a target selection',async()=>{
  const {service,id}=await setup([{key:'bad',ids:['m1'],blocked:true}])
  await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await service.idle()
  const result=(await service.getImport(id)).results[0]
  expect(result.status).toBe('blocked')
  expect(result.issues).toContainEqual(expect.objectContaining({code:'BAD',action:'请检查文件。'}))
  expect(result.issues.some(issue=>issue.code==='TARGET_REQUIRED' || issue.code==='TARGET_CONFLICT')).toBe(false)
})
