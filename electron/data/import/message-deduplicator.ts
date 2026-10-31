import { createHash } from 'node:crypto'
import type { Store } from '../db/open'
import type { Candidate } from '../../../src/shared/import-contract'
import type { ParsedMessage } from '../../../src/shared/conversation-model'
import { checkSignal } from './limits'

export function prepareFallbackLedger(store:Store) {
  // 文件存储限制大文件重导时的临时计数内存，不复制原始聊天正文。
  store.writer.pragma('temp_store = FILE')
  store.writer.exec('CREATE TEMP TABLE IF NOT EXISTS import_fallback_counts(signature TEXT PRIMARY KEY,available INTEGER NOT NULL,used INTEGER NOT NULL) WITHOUT ROWID')
  store.writer.pragma('temp.cache_size = -2048')
}

type SavedMessage={id:bigint;sent_at_ms:bigint;sender:string;kind:string;text:string;source_type:string|null;extra:string;
  reply_id:string|null;reply_namespace:string|null;reply_text:string|null;reply_sender:string|null;reply_time:bigint|null;has_reply:bigint}
const signature=(time:number,sender:string,kind:string,text:string,reply:unknown,attachments:unknown,sourceType:string|null,extra:unknown)=>
  createHash('sha256').update(JSON.stringify([time,sender,kind,text,reply,attachments,sourceType,extra])).digest('hex')

// Adapted from ChatLab incremental-importer.ts, bf8d5ac: consume each source's prior occurrences once.
export function createFallbackDeduplicator(store:Store,conversationId:string,signal:AbortSignal) {
  const db=store.writer,conversation=BigInt(conversationId)
  const maximum=(db.prepare('SELECT max(id) id FROM messages WHERE conversation_id=?').get(conversation) as {id:bigint|null}).id ?? 0n
  let built=false
  const consume=db.prepare('UPDATE temp.import_fallback_counts SET used=used+1 WHERE signature=? AND used<available')
  const add=db.prepare('INSERT INTO temp.import_fallback_counts VALUES(?,1,0) ON CONFLICT(signature) DO UPDATE SET available=available+1')
  const attachments=db.prepare('SELECT kind,locator,name,state FROM message_attachments WHERE message_id=? ORDER BY id')
  async function build() {
    db.exec('DELETE FROM temp.import_fallback_counts')
    const rows=db.prepare(`SELECT m.id,m.sent_at_ms,a.stable_account_key sender,m.kind,m.text,m.source_type,m.extra,
      r.original_id reply_id,r.id_namespace reply_namespace,r.text reply_text,r.sender_name reply_sender,r.sent_at_ms reply_time,
      CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END has_reply
      FROM messages m JOIN memberships p ON p.id=m.member_id JOIN accounts a ON a.id=p.account_id
      LEFT JOIN message_keys k ON k.message_id=m.id LEFT JOIN message_replies r ON r.message_id=m.id
      WHERE m.conversation_id=? AND m.time_bucket=0 AND (m.sort_time,m.id)>(?,?) AND m.id<=? AND k.message_id IS NULL
      ORDER BY m.sort_time,m.id LIMIT 500`)
    let after=0n,afterTime=-9007199254740992n
    while(true) {
      checkSignal(signal)
      const batch:SavedMessage[]=[]
      let bytes=0
      for(const row of rows.iterate(conversation,afterTime,after,maximum) as Iterable<SavedMessage>) {
        batch.push(row);after=row.id;afterTime=row.sent_at_ms
        bytes+=Object.values(row).reduce((total,value)=>total+(typeof value==='string' ? Buffer.byteLength(value):8),0)
        if(bytes>=4*1024**2)break
      }
      if(!batch.length)break
      // 关闭读取游标后再写入临时表，避免同连接读写游标冲突。
      for(const row of batch) {
        const media=attachments.all(row.id) as {kind:string;locator:string|null;name:string|null;state:string}[]
        const reply=row.has_reply===0n ? null:[row.reply_namespace,row.reply_id,row.reply_text,row.reply_sender,row.reply_time===null ? null:Number(row.reply_time)]
        add.run(signature(Number(row.sent_at_ms),row.sender,row.kind,row.text,reply,media.map(a=>[a.kind,a.locator,a.name,a.state]),row.source_type,JSON.parse(row.extra)))
      }
      await new Promise<void>(resolve=>setImmediate(resolve));checkSignal(signal)
    }
    built=true
  }
  return async(candidate:Candidate,m:ParsedMessage):Promise<boolean>=>{
    if(m.originalId!==null || m.sentAtMs===null || m.senderKind!=='member')return false
    const sender=candidate.members.find(member=>member.sourceKey===m.senderKey)?.stableAccountKey
    if(!sender)return false
    if(!built)await build()
    const reply=m.reply===null ? null:[m.reply.idNamespace,m.reply.originalId,m.reply.text,m.reply.senderName,m.reply.sentAtMs]
    const key=signature(m.sentAtMs,sender,m.kind,m.text,reply,m.attachments.map(a=>[a.kind,a.locator,a.name,a.state]),m.sourceType,m.extra)
    return consume.run(key).changes===1
  }
}
