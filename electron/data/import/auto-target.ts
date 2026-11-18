import { createHash } from 'node:crypto'
import type { Store } from '../db/open'
import type { Candidate } from '../../../src/shared/import-contract'
import type { MessageKind } from '../../../src/shared/conversation-model'
import type { StagedMessage } from './staging'
import { resolveTarget } from './identity'
import { checkSignal } from './limits'

type TrailingMessage = { sent_at_ms: bigint; kind: string; text: string; sender: string; id_namespace: string | null; original_id: string | null }
type WindowTarget = { conversationId: string; ids: (string | null)[] }
type WindowRecord = { key: string; id: string | null }
const signature = (time: number, sender: string, kind: string, content: string) =>
  createHash('sha256').update(JSON.stringify([time, sender, kind, content])).digest('hex')

// Adapted from ChatLab auto-import-matcher.ts, bf8d5ac; retain only historical target windows.
export async function resolveAutoTarget(store: Store, candidate: Candidate, messages: () => Iterable<StagedMessage>, signal = new AbortController().signal) {
  checkSignal(signal)
  const direct = resolveTarget(store, candidate)
  if (direct.status === 'blocked' || (direct.status === 'matched' && direct.target.conversationId !== null)) return direct
  const stableSenders = new Map(candidate.members.map(m => [m.sourceKey,m.stableAccountKey]))
  const windows = new Map<string,WindowTarget[]>(), matches = new Set<string>(), i = candidate.identity
  const isSiwx = candidate.formatId === 'echotrace' || candidate.formatId === 'weflow'
  const olderSources = isSiwx ? store.writer.prepare<[bigint], { parser_version: string }>(`
    SELECT DISTINCT o.parser_version FROM import_results r
    JOIN message_origins o ON o.import_result_id=r.id AND o.conversation_id=r.conversation_id
    WHERE r.conversation_id=? AND o.parser_id IN ('echotrace','weflow')
      AND o.parser_version IN ('f19beeadda27b-whomi.1','f19beeadda27b-whomi.2','f19beeadda27b-whomi.3')`) : undefined
  const olderVersions = new Map<string, Set<string>>()
  function hasOlderSource(conversationId: string, before: 'types' | 'shares') {
    let versions = olderVersions.get(conversationId)
    if (!versions) {
      versions = new Set(olderSources?.all(BigInt(conversationId)).map(row => row.parser_version))
      olderVersions.set(conversationId, versions)
    }
    return before === 'shares' ? versions.has('f19beeadda27b-whomi.3')
      : versions.has('f19beeadda27b-whomi.1') || versions.has('f19beeadda27b-whomi.2')
  }
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
  const current: WindowRecord[] = [], beforeTypes: WindowRecord[] = [], beforeShares: WindowRecord[] = []
  function matchWindow(recent: WindowRecord[], record: WindowRecord | null, before?: 'types' | 'shares') {
    if (!record) return
    recent.push(record)
    if (recent.length > 5) recent.shift()
    if (recent.length !== 5) return
    for (const target of windows.get(recent.map(record => record.key).join('')) ?? []) {
      if (!matches.has(target.conversationId) &&
          target.ids.every((value,index) => value === null || recent[index].id === null || value === recent[index].id) &&
          (!before || hasOlderSource(target.conversationId, before))) matches.add(target.conversationId)
    }
  }
  let processed=0
  for(const {message:m, siwxCompatibility} of messages()) {
    checkSignal(signal)
    if(++processed % 500 === 0) {await new Promise<void>(resolve=>setImmediate(resolve));checkSignal(signal)}
    const sender=m.senderKey===null ? null:stableSenders.get(m.senderKey)
    if(m.sentAtMs===null || !sender || !m.text.trim())continue
    const time = m.sentAtMs
    const id = m.originalId === null ? null : JSON.stringify([m.idNamespace,m.originalId])
    const entry = (kind: MessageKind): WindowRecord | null => kind === 'system' || kind === 'unknown' ? null
      : { key: signature(time,sender,kind,m.text), id }
    const record = entry(m.kind)
    matchWindow(current,record)
    if (isSiwx) {
      // Earlier parsers skipped records they could not classify when building the five-message window.
      const oldKind = siwxCompatibility?.kindBeforeTypeExpansion
      matchWindow(beforeTypes,oldKind === undefined ? record : entry(oldKind),'types')
      matchWindow(beforeShares,siwxCompatibility?.kindBeforeShareExpansion ? null : record,'shares')
    }
  }
  checkSignal(signal)
  return resolveTarget(store,candidate,{candidateId:candidate.candidateId,
    target:matches.size===1 ? {kind:'existing',conversationId:[...matches][0]}:{kind:'new'},confirmedAliases:[]})
}
