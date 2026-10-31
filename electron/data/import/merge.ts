import type { Store } from '../db/open'
import type { Candidate, TargetDecision } from '../../../src/shared/import-contract'
import { classifyMessage, resolveTarget, validateResolvedTarget, type ResolvedTarget } from './identity'
import type { StagedConversation } from './staging'
import { checkSignal, ImportFailure, importLimits } from './limits'
import { createFallbackDeduplicator, prepareFallbackLedger } from './message-deduplicator'
export type CommitResult = { conversationId: string; inserted: number; duplicates: number; summaryChanged: boolean; committedAt: number; candidates: {candidateId:string;inserted:number;duplicates:number}[] }
/** Trusted backend dependencies only; never accept hooks through IPC. */
export type CommitDependencies = { afterInsert?(count:number): void; beforeCommit?(): void; afterCommit?(): void; progress?(processed:number):void }
export function targetDecision(target: ResolvedTarget, candidateId = target.candidateId): TargetDecision {
  return { candidateId, target: target.kind === 'new' ? {kind:'new'} : {kind:'existing',conversationId:target.conversationId!}, confirmedAliases: [...target.confirmedAliases], selfMemberKey:target.selfMemberKey }
}
export function reliableTargetKey(target: ResolvedTarget): string | null {
  const i=target.identity
  return i.platform && i.namespace && i.ownerKey && i.conversationKey ? JSON.stringify([i.platform,i.namespace,i.ownerKey,i.conversationKey]) : null
}
export function createCommitter(dependencies: CommitDependencies = {}) {
  return async (store: Store, staged: StagedConversation, target: ResolvedTarget, signal: AbortSignal): Promise<CommitResult> => {
    const db = store.writer
    checkSignal(signal); validateResolvedTarget(store,target)
    if (!staged.candidateIds.length || new Set(staged.candidateIds).size !== staged.candidateIds.length || staged.candidates.length !== staged.candidateIds.length) throw new ImportFailure('INVALID_SELECTION')
    let committed = false, inserted = 0, duplicates = 0, membershipChanged = false
    const repliesToResolve = new Set<bigint>()
    prepareFallbackLedger(store)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!db.prepare('SELECT id FROM import_jobs WHERE id=?').get(BigInt(staged.jobId))) throw new ImportFailure('INVALID_JOB')
      const originals = new Map(staged.candidates.map(c => [c.candidateId,c]))
      const first = originals.get(target.candidateId)
      if (!first) throw new ImportFailure('INVALID_CANDIDATE')
      const decisions = new Map(staged.candidates.map(c => [c.candidateId, staged.decisions?.find(d => d.candidateId === c.candidateId) ?? targetDecision(target, c.candidateId)]))
      const resolved = staged.candidates.map(c => {
        const r=resolveTarget(store,c,decisions.get(c.candidateId))
        if (r.status !== 'matched') throw new ImportFailure('TARGET_CONFLICT')
        if (r.target.conversationId !== target.conversationId || (target.kind === 'new' && c.candidateId !== target.candidateId && (reliableTargetKey(target) === null || reliableTargetKey(r.target) !== reliableTargetKey(target)))) throw new ImportFailure('TARGET_CONFLICT')
        return r.target
      })
      let conversationId = resolved[0].conversationId
      if (conversationId === null) conversationId = db.prepare('INSERT INTO conversations(title,kind,created_at_ms) VALUES (?,?,?)').run(first.title, first.kind, Date.now()).lastInsertRowid.toString()
      const conversation = BigInt(conversationId), bound = new Map<string,ResolvedTarget>(), sources = new Map<string,bigint>(), results = new Map<string,{id:bigint;candidateId:string;inserted:number;duplicates:number}>()
      function canonicalAccount(platform: string, key: string): bigint {
        const found = db.prepare('SELECT account_id id FROM account_aliases WHERE platform=? AND alias_key=? UNION SELECT id FROM accounts WHERE platform=? AND stable_account_key=?').get(platform,key,platform,key) as {id:bigint}|undefined
        if (found) return found.id
        return db.prepare('INSERT INTO accounts(platform,stable_account_key) VALUES (?,?)').run(platform,key).lastInsertRowid as bigint
      }
      for (const [index,c] of staged.candidates.entries()) {
        if (!staged.candidateIds.includes(c.candidateId)) throw new ImportFailure('INVALID_SELECTION')
        const initial=resolved[index]
        for (const alias of initial.confirmedAliases) db.prepare("INSERT INTO account_aliases(platform,alias_key,account_id,source) VALUES (?,?,?,'user') ON CONFLICT(platform,alias_key) DO NOTHING").run(alias.platform,alias.aliasKey,canonicalAccount(alias.platform,alias.accountKey))
        const resolution = resolveTarget(store,c,{...targetDecision(initial),target:{kind:'existing',conversationId}})
        if (resolution.status !== 'matched') throw new ImportFailure('TARGET_CONFLICT')
        const t=resolution.target,i=t.identity
        let source = db.prepare('SELECT id FROM source_conversations WHERE conversation_id=? AND platform=? AND owner_key IS ? AND conversation_key IS ? AND namespace=?').get(conversation,i.platform,i.ownerKey,i.conversationKey,i.namespace) as {id:bigint}|undefined
        if (!source) source = {id:db.prepare('INSERT INTO source_conversations(conversation_id,platform,owner_key,conversation_key,namespace) VALUES (?,?,?,?,?)').run(conversation,i.platform,i.ownerKey,i.conversationKey,i.namespace).lastInsertRowid as bigint}
        sources.set(c.candidateId,source.id)
        const fresh=resolveTarget(store,c,{...targetDecision(t),target:{kind:'existing',conversationId}})
        if(fresh.status !== 'matched') throw new ImportFailure('TARGET_CONFLICT')
        bound.set(c.candidateId,fresh.target)
        const prior = db.prepare('SELECT status FROM import_results WHERE job_id=? AND candidate_id=?').get(BigInt(staged.jobId),c.candidateId) as {status:string}|undefined
        if (prior?.status === 'committed') throw new ImportFailure('ALREADY_COMMITTED')
        db.prepare("INSERT INTO import_results(job_id,candidate_id,conversation_id,status,phase) VALUES (?,?,?,'running','committing') ON CONFLICT(job_id,candidate_id) DO UPDATE SET conversation_id=excluded.conversation_id,status='running',phase='committing'").run(BigInt(staged.jobId),c.candidateId,conversation)
        const row = db.prepare('SELECT id FROM import_results WHERE job_id=? AND candidate_id=?').get(BigInt(staged.jobId),c.candidateId) as {id:bigint}
        results.set(c.candidateId,{id:row.id,candidateId:c.candidateId,inserted:0,duplicates:0})
      }
      const members = new Map<string,bigint>()
      function member(c: Candidate, key: string): bigint {
        const lookup = JSON.stringify([c.candidateId,key]), cached = members.get(lookup)
        if (cached !== undefined) return cached
        const m = c.members.find(m => m.sourceKey === key)
        if (!m) throw new ImportFailure('MEMBER_MISSING')
        const source = sources.get(c.candidateId)!, t = bound.get(c.candidateId)!
        let row = db.prepare('SELECT id FROM memberships WHERE source_conversation_id=? AND source_key=?').get(source,key) as {id:bigint}|undefined
        if (!row) {
          const canonical = t.confirmedAliases.find(a => a.aliasKey === m.stableAccountKey)?.accountKey ?? m.stableAccountKey
          row = {id: db.prepare('INSERT INTO memberships(conversation_id,source_conversation_id,source_key,display_name,account_id,self_hint) VALUES (?,?,?,?,?,?)').run(conversation,source,key,m.displayName,canonical ? canonicalAccount(c.identity.platform,canonical) : null,m.selfHint === null ? null : Number(m.selfHint)).lastInsertRowid as bigint}
          membershipChanged = true
          if (m.selfHint === true) db.prepare("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (?,?,'candidate','parser')").run(conversation,row.id)
          if (t.selfMemberKey === undefined && t.confirmedSelf === key && !db.prepare("SELECT 1 FROM self_confirmations WHERE conversation_id=? AND status='confirmed'").get(conversation)) db.prepare("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (?,?,'confirmed','user')").run(conversation,row.id)
        }
        members.set(lookup,row.id); return row.id
      }
      const insertMessage = db.prepare('INSERT INTO messages(conversation_id,member_id,sender_kind,sender_name,sent_at_ms,time_raw,time_precision,timezone,kind,text,ordinal,source_type,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      let fallbackDuplicate = createFallbackDeduplicator(store, conversationId,signal), fallbackCandidate = ''
      let batchCount = 0, batchBytes = 0
      for (const record of staged.messages()) {
        checkSignal(signal)
        const {candidateId,message:m,origin:o} = record, t = bound.get(candidateId), c = originals.get(candidateId), result = results.get(candidateId)
        const size=Buffer.byteLength(JSON.stringify(m))
        if(batchCount && (batchCount>=importLimits.batchRecords || batchBytes+size>importLimits.batchBytes)) {
          dependencies.progress?.(inserted+duplicates)
          await new Promise<void>(resolve=>setImmediate(resolve));checkSignal(signal);batchCount=0;batchBytes=0
        }
        if (!t || !c || !result) throw new ImportFailure('INVALID_CANDIDATE')
        if(fallbackCandidate!==candidateId) {
          fallbackCandidate=candidateId
          fallbackDuplicate=createFallbackDeduplicator(store,conversationId,signal)
        }
        let classification = m.originalId===null && await fallbackDuplicate(c,m) ? 'duplicate':classifyMessage(store,t,m,o)
        if (classification === 'ambiguous') classification = 'new'
        if (classification === 'duplicate') {
          result.duplicates++; duplicates++
          if (m.reply?.originalId && m.reply.idNamespace === 'wechat:server-message' && m.originalId && m.idNamespace === 'wechat:server-message') {
            // 重导入只补全原消息与摘录均相符的引用，保留已解析的关系。
            const existing = db.prepare(`SELECT r.message_id FROM message_replies r
              JOIN message_keys k ON k.message_id=r.message_id AND k.conversation_id=r.conversation_id
              JOIN messages m ON m.id=r.message_id AND m.conversation_id=r.conversation_id
              WHERE k.conversation_id=? AND k.id_namespace=? AND k.original_id=? AND m.text=? AND m.sender_name=?
              AND r.state='unresolved' AND r.text IS ? AND (r.original_id IS NULL OR (r.original_id=? AND r.id_namespace=?))`).get(conversation,m.idNamespace,m.originalId,m.text,m.senderName,m.reply.text,m.reply.originalId,m.reply.idNamespace) as {message_id:bigint} | undefined
            if (existing) {
              db.prepare('UPDATE message_replies SET original_id=?,id_namespace=?,sender_name=coalesce(sender_name,?),sent_at_ms=coalesce(sent_at_ms,?) WHERE message_id=?').run(m.reply.originalId,m.reply.idNamespace,m.reply.senderName,m.reply.sentAtMs,existing.message_id)
              repliesToResolve.add(existing.message_id)
            }
          }
        }
        else {
          const id = insertMessage.run(conversation,m.senderKind === 'member' && m.senderKey ? member(c,m.senderKey) : null,m.senderKind,m.senderName,m.sentAtMs,m.timeRaw,m.timePrecision,m.timezone,m.kind,m.text,m.ordinal,m.sourceType,JSON.stringify(m.extra)).lastInsertRowid
          if (m.originalId !== null) db.prepare('INSERT INTO message_keys VALUES (?,?,?,?)').run(conversation,m.idNamespace,m.originalId,id)
          db.prepare('INSERT INTO message_origins(message_id,conversation_id,import_result_id,file_fingerprint,source_conversation_key,ordinal,parser_id,parser_version) VALUES (?,?,?,?,?,?,?,?)').run(id,conversation,result.id,o.fingerprint,o.sourceConversationKey,o.ordinal,o.parserId,o.parserVersion)
          for (const a of m.attachments) db.prepare('INSERT INTO message_attachments(message_id,kind,locator,name,state) VALUES (?,?,?,?,?)').run(id,a.kind,a.locator,a.name,a.state)
          if (m.reply) {
            db.prepare('INSERT INTO message_replies(message_id,conversation_id,original_id,id_namespace,text,sender_name,sent_at_ms) VALUES (?,?,?,?,?,?,?)').run(id,conversation,m.reply.originalId,m.reply.idNamespace,m.reply.text,m.reply.senderName,m.reply.sentAtMs)
            repliesToResolve.add(BigInt(id))
          }
          result.inserted++; inserted++; dependencies.afterInsert?.(inserted)
        }
        batchCount++; batchBytes += size
        if (batchCount >= importLimits.batchRecords || batchBytes >= importLimits.batchBytes) { dependencies.progress?.(inserted+duplicates); await new Promise<void>(resolve => setImmediate(resolve)); checkSignal(signal); batchCount=0; batchBytes=0 }
      }
      dependencies.progress?.(inserted+duplicates)
      const resolveReply = db.prepare(`UPDATE message_replies SET target_message_id=(SELECT k.message_id FROM message_keys k WHERE k.conversation_id=message_replies.conversation_id AND k.id_namespace=message_replies.id_namespace AND k.original_id=message_replies.original_id), state='resolved'
        WHERE message_id=? AND EXISTS (SELECT 1 FROM message_keys k WHERE k.conversation_id=message_replies.conversation_id AND k.id_namespace=message_replies.id_namespace AND k.original_id=message_replies.original_id)`)
      for (const id of repliesToResolve) resolveReply.run(id)
      const explicitSelf: {id:bigint|null;account:bigint|null}[]=[]
      for(const c of staged.candidates) {
        const key=bound.get(c.candidateId)!.selfMemberKey
        if(key === undefined) continue
        const id=key === null ? null : member(c,key)
        const account=id === null ? null : (db.prepare('SELECT account_id FROM memberships WHERE id=?').get(id) as {account_id:bigint|null}).account_id
        explicitSelf.push({id,account})
      }
      if(explicitSelf.length) {
        const chosen=explicitSelf[0]
        if(explicitSelf.some(x => x.id !== chosen.id && (x.id === null || chosen.id === null || x.account === null || x.account !== chosen.account))) throw new ImportFailure('SELF_CONFLICT')
        db.prepare("UPDATE self_confirmations SET status='revoked' WHERE conversation_id=? AND status='confirmed'").run(conversation)
        if(chosen.id === null) db.prepare('INSERT INTO self_opt_outs VALUES (?) ON CONFLICT DO NOTHING').run(conversation)
        else { db.prepare('DELETE FROM self_opt_outs WHERE conversation_id=?').run(conversation); db.prepare("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (?,?,'confirmed','user')").run(conversation,chosen.id) }
      }
      const committedAt = Date.now()
      for (const r of results.values()) db.prepare("UPDATE import_results SET status='committed',phase=?,added_count=?,skipped_count=?,committed_at_ms=?,error_code=NULL,error_action=NULL WHERE id=?").run(r.inserted ? 'saved':'duplicate',r.inserted,r.duplicates,committedAt,r.id)
      const summaryChanged = inserted > 0 || membershipChanged
      if (summaryChanged) db.prepare("INSERT INTO conversation_summaries(conversation_id,status) VALUES (?,'pending') ON CONFLICT(conversation_id) DO UPDATE SET status='pending'").run(conversation)
      checkSignal(signal); dependencies.beforeCommit?.(); db.exec('COMMIT'); committed = true
      dependencies.afterCommit?.()
      return {conversationId,inserted,duplicates,summaryChanged,committedAt,candidates:[...results.values()].map(({candidateId,inserted,duplicates}) => ({candidateId,inserted,duplicates}))}
    } catch (error) { if (!committed && db.inTransaction) db.exec('ROLLBACK'); throw error }
  }
}
export const commitConversation = createCommitter()
