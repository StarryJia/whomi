import { createHash } from 'node:crypto'
import type { Store } from '../db/open'
import type { Candidate } from '../../../src/shared/import-contract'
import type { StagedMessage } from './staging'
import { resolveTarget } from './identity'
import { checkSignal } from './limits'

type TrailingMessage = { sent_at_ms: bigint; kind: string; text: string; sender: string; id_namespace: string | null; original_id: string | null }
type WindowTarget = { conversationId: string; ids: (string | null)[] }
const signature = (time: number, sender: string, kind: string, content: string) =>
  createHash('sha256').update(JSON.stringify([time, sender, kind, content])).digest('hex')

// Adapted from ChatLab auto-import-matcher.ts, bf8d5ac; retain only historical target windows.
export async function resolveAutoTarget(store: Store, candidate: Candidate, messages: () => Iterable<StagedMessage>, signal = new AbortController().signal) {
  checkSignal(signal)
  const direct = resolveTarget(store, candidate)
  if (direct.status === 'blocked' || (direct.status === 'matched' && direct.target.conversationId !== null)) return direct
  const stableSenders = new Map(candidate.members.map(m => [m.sourceKey,m.stableAccountKey]))
  const windows = new Map<string,WindowTarget[]>(), matches = new Set<string>(), i = candidate.identity
  const exact = new Set(candidate.fingerprint === null ? [] : (store.writer.prepare('SELECT DISTINCT conversation_id FROM message_origins WHERE file_fingerprint=? AND source_conversation_key=?').all(candidate.fingerprint,candidate.sourceKey) as {conversation_id:bigint}[]).map(r=>r.conversation_id.toString()))
  const possible = store.writer.prepare('SELECT id,kind FROM conversations').iterate() as Iterable<{ id: bigint; kind: string }>
  let checked = 0
  for (const c of possible) {
    checkSignal(signal)
    if (++checked % 100 === 0) {await new Promise<void>(resolve=>setImmediate(resolve));checkSignal(signal)}
    if (candidate.kind !== 'unknown' && c.kind !== 'unknown' && c.kind !== candidate.kind) continue
    const sources = store.writer.prepare('SELECT platform,owner_key,conversation_key,namespace FROM source_conversations WHERE conversation_id=?').all(c.id) as { platform: string; owner_key: string | null; conversation_key: string | null; namespace: string }[]
    if (!sources.length || sources.some(s => (i.platform && s.platform && i.platform !== s.platform) ||
      (i.ownerKey && s.owner_key && i.ownerKey !== s.owner_key) ||
      (i.namespace === s.namespace && i.conversationKey && s.conversation_key && i.conversationKey !== s.conversation_key))) continue
    const conversationId=c.id.toString()
    if(exact.has(conversationId)) matches.add(conversationId)
    const rows = store.writer.prepare(`SELECT m.sent_at_ms,m.kind,m.text,a.stable_account_key sender,k.id_namespace,k.original_id
      FROM messages m JOIN memberships p ON p.id=m.member_id JOIN accounts a ON a.id=p.account_id
      LEFT JOIN message_keys k ON k.message_id=m.id
      WHERE m.conversation_id=? AND m.sent_at_ms IS NOT NULL AND m.kind NOT IN ('system','unknown') AND length(trim(m.text))>0
      ORDER BY m.sent_at_ms DESC,m.id DESC LIMIT 5`).all(c.id) as TrailingMessage[]
    if(rows.length!==5)continue
    rows.reverse()
    const key=rows.map(r=>signature(Number(r.sent_at_ms),r.sender,r.kind,r.text)).join('')
    const target={conversationId,ids:rows.map(r=>r.original_id===null ? null:JSON.stringify([r.id_namespace,r.original_id]))}
    windows.set(key,[...(windows.get(key) ?? []),target])
  }
  const recent:string[]=[],ids:(string|null)[]=[]
  let processed=0
  for(const {message:m} of messages()) {
    checkSignal(signal)
    if(++processed % 500 === 0) {await new Promise<void>(resolve=>setImmediate(resolve));checkSignal(signal)}
    const sender=m.senderKey===null ? null:stableSenders.get(m.senderKey)
    if(m.sentAtMs===null || !sender || m.kind==='system' || m.kind==='unknown' || !m.text.trim())continue
    recent.push(signature(m.sentAtMs,sender,m.kind,m.text));ids.push(m.originalId===null ? null:JSON.stringify([m.idNamespace,m.originalId]))
    if(recent.length>5){recent.shift();ids.shift()}
    if(recent.length!==5)continue
    for(const target of windows.get(recent.join('')) ?? []) {
      if(target.ids.every((id,index)=>id===null || ids[index]===null || id===ids[index]))matches.add(target.conversationId)
    }
  }
  checkSignal(signal)
  return resolveTarget(store,candidate,{candidateId:candidate.candidateId,
    target:matches.size===1 ? {kind:'existing',conversationId:[...matches][0]}:{kind:'new'},confirmedAliases:[]})
}
