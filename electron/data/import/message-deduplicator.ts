import { createHash } from 'node:crypto'
import type { Store } from '../db/open'
import type { Candidate } from '../../../src/shared/import-contract'
import type { ParsedMessage, ParsedReply } from '../../../src/shared/conversation-model'
import { checkSignal } from './limits'
import { hasWechatRecallMarker, wechatTypeNumber } from '../parsers/wechat-recall'

export function prepareFallbackLedger(store:Store) {
  // 文件存储限制大文件重导时的临时计数内存，不复制原始聊天正文。
  store.writer.pragma('temp_store = FILE')
  store.writer.exec('CREATE TEMP TABLE IF NOT EXISTS import_fallback_counts(signature TEXT PRIMARY KEY,available INTEGER NOT NULL,used INTEGER NOT NULL) WITHOUT ROWID')
  store.writer.pragma('temp.cache_size = -2048')
}

type SavedMessage={id:bigint;sent_at_ms:bigint;sender:string|null;kind:string;text:string;source_type:string|null;extra:string;
  reply_id:string|null;reply_namespace:string|null;reply_text:string|null;reply_sender:string|null;reply_time:bigint|null;
  has_reply:bigint;legacy_wechat_bucket:LegacyWeChatBucket|null}
const signature=(time:number,sender:string|null,kind:string,text:string,reply:unknown,attachments:unknown,sourceType:string|null,extra:unknown)=>
  createHash('sha256').update(JSON.stringify([time,sender,kind,text,reply,attachments,sourceType,extra])).digest('hex')

function recallSignature(time: number, text: string, sourceType: string | null, extra: Record<string, unknown>): string {
  const { selfHint: _selfHint, ...fields } = extra
  if (Object.hasOwn(fields, 'localType')) fields.localType = wechatTypeNumber(fields.localType) ?? fields.localType
  // 未提供文字标签时，导出会用数字类型作来源标签。旧分类附带的回复和附件不属于通知。
  const label = wechatTypeNumber(sourceType)?.toString() ?? sourceType
  return signature(time, null, 'system', text, null, [], label, fields)
}

type LegacyWeChatBucket = 'legacy-wechat' | 'legacy-wechat-app' | 'legacy-wechat-reply'
const legacyWeChatKey = (bucket: LegacyWeChatBucket, key: string) => `${bucket}:${key}`
const recognizedWeChatKinds = new Set(['call', 'contact', 'file', 'forward', 'link', 'poke', 'reply', 'sticker'])
const replyFields = (reply: ParsedReply | null) => reply === null ? null
  : [reply.idNamespace, reply.originalId, reply.text, reply.senderName, reply.sentAtMs]

function isWeChatApplication(sourceType: string | null, localType: unknown): boolean {
  if(sourceType==='链接/文件')return true
  const type=typeof localType==='string' && /^\d+$/.test(localType) ? Number(localType) : localType
  return typeof type==='number' && Number.isSafeInteger(type) && type>0 && type % 2**32===49
}

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
      CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END has_reply,
      CASE WHEN m.kind IN ('unknown','reply') THEN (
        SELECT min(CASE WHEN m.kind='reply' THEN 'legacy-wechat-reply'
          WHEN o.parser_version='f19beeadda27b-whomi.3' THEN 'legacy-wechat-app' ELSE 'legacy-wechat' END)
        FROM message_origins o WHERE o.message_id=m.id AND o.conversation_id=m.conversation_id
          AND o.parser_id IN ('echotrace','weflow')
          AND o.parser_version IN ('f19beeadda27b-whomi.1','f19beeadda27b-whomi.2','f19beeadda27b-whomi.3')
          AND (m.kind='unknown' OR o.parser_version!='f19beeadda27b-whomi.3')
      ) END legacy_wechat_bucket
      FROM messages m LEFT JOIN memberships p ON p.id=m.member_id LEFT JOIN accounts a ON a.id=p.account_id
      LEFT JOIN message_keys k ON k.message_id=m.id LEFT JOIN message_replies r ON r.message_id=m.id
      WHERE m.conversation_id=? AND m.time_bucket=0 AND (m.sort_time,m.id)>(?,?) AND m.id<=? AND k.message_id IS NULL
        AND (a.stable_account_key IS NOT NULL OR (m.sender_kind='system' AND m.kind='system' AND EXISTS
          (SELECT 1 FROM message_origins o WHERE o.message_id=m.id AND o.parser_id IN ('echotrace','weflow'))))
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
        const extra=JSON.parse(row.extra) as Record<string,unknown>
        if (row.sender === null) {
          if (hasWechatRecallMarker(row.source_type, extra.localType, row.text)) {
            add.run(recallSignature(Number(row.sent_at_ms), row.text, row.source_type, extra))
          }
          continue
        }
        const media=attachments.all(row.id) as {kind:string;locator:string|null;name:string|null;state:string}[]
        const reply=row.has_reply===0n ? null:[row.reply_namespace,row.reply_id,row.reply_text,row.reply_sender,row.reply_time===null ? null:Number(row.reply_time)]
        const key=signature(Number(row.sent_at_ms),row.sender,row.kind,row.text,reply,media.map(a=>[a.kind,a.locator,a.name,a.state]),row.source_type,extra)
        const bucket=row.legacy_wechat_bucket
        // 两种匹配路径共用旧记录的剩余次数。
        const useLegacyBucket=bucket && media.length===0 &&
          (bucket!=='legacy-wechat-app' || isWeChatApplication(row.source_type,extra.localType))
        add.run(useLegacyBucket ? legacyWeChatKey(bucket,key) : key)
      }
      await new Promise<void>(resolve=>setImmediate(resolve));checkSignal(signal)
    }
    built=true
  }
  return async(candidate:Candidate,m:ParsedMessage,previousReply?:ParsedReply):Promise<boolean>=>{
    if(m.originalId!==null || m.sentAtMs===null)return false
    const recall = m.senderKind === 'system' && m.kind === 'system' && (candidate.formatId === 'echotrace' || candidate.formatId === 'weflow')
      && hasWechatRecallMarker(m.sourceType, m.extra.localType, m.text)
    const sender = m.senderKind === 'member' ? candidate.members.find(member => member.sourceKey === m.senderKey)?.stableAccountKey : null
    if (!sender && !recall) return false
    if(!built)await build()
    const reply=replyFields(m.reply)
    const key = recall ? recallSignature(m.sentAtMs, m.text, m.sourceType, m.extra)
      : signature(m.sentAtMs,sender ?? null,m.kind,m.text,reply,m.attachments.map(a=>[a.kind,a.locator,a.name,a.state]),m.sourceType,m.extra)
    if(consume.run(key).changes===1)return true
    if (!sender) return false
    if(m.kind==='reply' && consume.run(legacyWeChatKey('legacy-wechat-reply',key)).changes===1)return true
    if(previousReply && (candidate.formatId==='echotrace' || candidate.formatId==='weflow')) {
      const legacy=signature(m.sentAtMs,sender,'reply',m.text,replyFields(previousReply),[],m.sourceType,m.extra)
      if(consume.run(legacyWeChatKey('legacy-wechat-reply',legacy)).changes===1)return true
    }
    if(m.kind==='unknown')return consume.run(legacyWeChatKey('legacy-wechat-app',key)).changes===1 ||
      consume.run(legacyWeChatKey('legacy-wechat',key)).changes===1
    if((candidate.formatId==='echotrace' || candidate.formatId==='weflow') && recognizedWeChatKinds.has(m.kind)) {
      const legacy=signature(m.sentAtMs,sender,'unknown',m.text,reply,[],m.sourceType,m.extra)
      if((m.kind==='link' || m.kind==='sticker') && consume.run(legacyWeChatKey('legacy-wechat-app',legacy)).changes===1)return true
      return consume.run(legacyWeChatKey('legacy-wechat',legacy)).changes===1
    }
    return false
  }
}
