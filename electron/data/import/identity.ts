import type { Store } from '../db/open'
import { normalizeModel, type LocalId, type ParsedMessage, type SourceIdentity } from '../../../src/shared/conversation-model'
import type { AccountAlias, Candidate, SourceRecordKey, TargetDecision } from '../../../src/shared/import-contract'

export type ResolvedTarget = Readonly<{
  kind: 'new' | 'existing'; conversationId: LocalId | null; candidateId: string
  identity: Readonly<SourceIdentity>; sourceKey: string
  confirmedAliases: readonly Readonly<AccountAlias>[]
  /** Candidate member source key, never a display name or a persisted confirmation. */
  confirmedSelf: string | null; selfHints: readonly string[]
  selfMemberKey?: string | null
}>
export type TargetResolution = { status: 'matched'; target: ResolvedTarget }
  | { status: 'needs-choice'; action: string }
  | { status: 'blocked'; code: string; action: string }
export type MessageClassification = 'new' | 'duplicate' | 'ambiguous'
export const ambiguousMessageAction = '请改用包含可靠消息标识的导出格式。'
type Account = { id: bigint; stable_account_key: string }
type Source = { conversation_id: bigint; platform: string; owner_key: string | null; conversation_key: string | null; namespace: string }
const trusted = new WeakMap<ResolvedTarget, Store>()
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function invalid(): never { throw new Error('请重新选择会话并确认账号映射。') }
function localId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 19) invalid()
  const id = BigInt(value)
  if (id > 9223372036854775807n) invalid()
  return id
}
function assertTarget(store: Store, target: ResolvedTarget) {
  if (trusted.get(target) !== store) invalid()
}
export const validateResolvedTarget = assertTarget
function account(store: Store, platform: string, key: string): Account | undefined {
  const direct = store.writer.prepare('SELECT id,stable_account_key FROM accounts WHERE platform=? AND stable_account_key=?').get(platform, key) as Account | undefined
  const alias = store.writer.prepare('SELECT a.id,a.stable_account_key FROM account_aliases x JOIN accounts a ON a.id=x.account_id WHERE x.platform=? AND x.alias_key=? AND a.platform=x.platform').get(platform, key) as Account | undefined
  if (direct && alias && direct.id !== alias.id) invalid()
  return direct ?? alias
}
function aliasesFor(store: Store, candidate: Candidate, supplied: unknown) {
  if (!Array.isArray(supplied)) invalid()
  const platform = candidate.identity.platform
  const observed = new Set([candidate.identity.ownerKey, ...candidate.members.map(m => m.stableAccountKey)].filter(text))
  const pending = new Map<string, string>()
  for (const a of supplied) {
    if (!object(a) || a.platform !== platform || !text(a.aliasKey) || !text(a.accountKey) || a.aliasKey === a.accountKey ||
        (!observed.has(a.aliasKey) && !observed.has(a.accountKey))) invalid()
    if (pending.has(a.aliasKey) && pending.get(a.aliasKey) !== a.accountKey) invalid()
    pending.set(a.aliasKey, a.accountKey)
  }
  const canonical = (key: string): string => {
    const visited = new Set<string>()
    while (pending.has(key)) {
      if (visited.has(key)) invalid()
      visited.add(key); key = pending.get(key)!
    }
    return account(store, platform, key)?.stable_account_key ?? key
  }
  const aliases: AccountAlias[] = []
  for (const [aliasKey, key] of pending) {
    const accountKey = canonical(key), previous = account(store, platform, aliasKey), destination = account(store, platform, accountKey)
    if (!observed.has(accountKey) && !destination && !store.writer.prepare('SELECT 1 FROM source_conversations WHERE platform=? AND owner_key=? LIMIT 1').get(platform, accountKey)) invalid()
    if (previous && (!destination || previous.id !== destination.id)) invalid()
    aliases.push({ platform, aliasKey, accountKey })
  }
  return { aliases, canonical }
}
function validateCandidate(candidate: Candidate) {
  if (!object(candidate) || !text(candidate.candidateId) || !text(candidate.sourceKey) || candidate.status !== 'staged' ||
      !Array.isArray(candidate.issues) || candidate.issues.some(i => i.severity === 'blocking') || !object(candidate.identity) || !Array.isArray(candidate.members)) invalid()
  const i = candidate.identity
  if (typeof i.platform !== 'string' || typeof i.namespace !== 'string' ||
      !(i.ownerKey === null || text(i.ownerKey)) || !(i.conversationKey === null || text(i.conversationKey))) invalid()
  const sources = new Set<string>()
  for (const m of candidate.members) {
    if (!object(m) || !text(m.sourceKey) || sources.has(m.sourceKey) || typeof m.displayName !== 'string' ||
        !(m.stableAccountKey === null || text(m.stableAccountKey)) || ![null, true, false].includes(m.selfHint)) invalid()
    sources.add(m.sourceKey)
  }
}
function reusableSelf(store: Store, candidate: Candidate, canonical: (key: string) => string, conversationId: string | null): string | null {
  const platform = candidate.identity.platform
  if (conversationId !== null && store.writer.prepare('SELECT 1 FROM self_opt_outs WHERE conversation_id=?').get(localId(conversationId))) return null
  const confirmed = store.writer.prepare(`SELECT DISTINCT a.stable_account_key FROM self_confirmations s
    JOIN memberships m ON m.id=s.member_id JOIN accounts a ON a.id=m.account_id
    WHERE s.status='confirmed' AND s.source='user' AND a.platform=?`).all(platform) as { stable_account_key: string }[]
  // A platform with conflicting explicit confirmations cannot supply an implicit confirmation.
  const keys = new Set(confirmed.map(a => canonical(a.stable_account_key)))
  if (keys.size !== 1) return null
  const [key] = keys
  const matching = candidate.members.filter(m => m.stableAccountKey && canonical(m.stableAccountKey) === key)
  if (matching.length !== 1 || matching[0].selfHint === false) return null
  const member = matching[0]
  if (candidate.members.some(m => m.selfHint === true && m.sourceKey !== member.sourceKey)) return null
  if (candidate.identity.ownerKey && canonical(candidate.identity.ownerKey) !== key) return null
  return member.sourceKey
}

/** Read-only: source mappings, account aliases and any new conversation belong to the later merge transaction. */
export function resolveTarget(store: Store, candidate: Candidate, decision?: TargetDecision): TargetResolution {
  try {
    validateCandidate(candidate)
    if (decision?.selfMemberKey !== undefined && decision.selfMemberKey !== null && !candidate.members.some(m => m.sourceKey === decision.selfMemberKey)) invalid()
    if (decision !== undefined && (!object(decision) || decision.candidateId !== candidate.candidateId || !object(decision.target) ||
        !['new', 'existing'].includes(decision.target.kind) || !Array.isArray(decision.confirmedAliases))) invalid()
    const { aliases, canonical } = aliasesFor(store, candidate, decision?.confirmedAliases ?? [])
    const identity = { ...candidate.identity, ownerKey: candidate.identity.ownerKey ? canonical(candidate.identity.ownerKey) : null }
    const reliable = text(identity.platform) && text(identity.namespace) && text(identity.ownerKey) && text(identity.conversationKey)
    const possible = reliable ? store.writer.prepare(`SELECT conversation_id,platform,owner_key,conversation_key,namespace
      FROM source_conversations WHERE platform=? AND namespace=? AND conversation_key=? AND owner_key IS NOT NULL`).all(identity.platform, identity.namespace, identity.conversationKey) as Source[] : []
    const matches = possible.filter(s => canonical(s.owner_key!) === identity.ownerKey)
    const targets = new Set(matches.map(s => s.conversation_id.toString()))
    if (targets.size > 1) invalid()
    const mapped = [...targets][0]
    let conversationId: string | null = mapped ?? null
    if (decision?.target.kind === 'existing') {
      const id = localId(decision.target.conversationId)
      if (!store.writer.prepare('SELECT 1 FROM conversations WHERE id=?').get(id) || (mapped && mapped !== id.toString())) invalid()
      const sources = store.writer.prepare('SELECT conversation_id,platform,owner_key,conversation_key,namespace FROM source_conversations WHERE conversation_id=?').all(id) as Source[]
      for (const s of sources) {
        if (text(identity.platform) && text(s.platform) && identity.platform !== s.platform) invalid()
        if (identity.platform === s.platform && identity.ownerKey !== null && s.owner_key !== null && identity.ownerKey !== canonical(s.owner_key)) invalid()
        if (identity.platform === s.platform && identity.namespace === s.namespace &&
            identity.conversationKey !== null && s.conversation_key !== null && identity.conversationKey !== s.conversation_key) invalid()
      }
      conversationId = id.toString()
    } else if (decision?.target.kind === 'new') {
      if (mapped) invalid()
      conversationId = null
    } else if (!mapped && !reliable && store.writer.prepare('SELECT 1 FROM conversations LIMIT 1').get()) {
      return { status: 'needs-choice', action: '请选择本次导入的目标会话。' }
    }
    const target: ResolvedTarget = Object.freeze({
      kind: conversationId === null ? 'new' : 'existing', conversationId, candidateId: candidate.candidateId,
      identity: Object.freeze(identity), sourceKey: candidate.sourceKey,
      confirmedAliases: Object.freeze(aliases.map(a => Object.freeze(a))),
      confirmedSelf: reusableSelf(store, candidate, canonical, conversationId), selfHints: Object.freeze(candidate.members.filter(m => m.selfHint === true).map(m => m.sourceKey)),
      selfMemberKey: decision?.selfMemberKey,
    })
    trusted.set(target, store)
    return { status: 'matched', target }
  } catch {
    return { status: 'blocked', code: 'TARGET_CONFLICT', action: '请重新选择会话并确认账号映射。' }
  }
}

/** The adapter namespace has stable message semantics; exporter and account metadata must not change it. */
export function messageKeyNamespace(target: ResolvedTarget, namespace: string): string {
  if (!trusted.has(target) || !text(namespace)) invalid()
  return namespace
}
function validateRecord(store: Store, target: ResolvedTarget, message: ParsedMessage, origin: SourceRecordKey) {
  assertTarget(store, target)
  const normalized = normalizeModel(message)
  if (!object(origin) || !text(origin.fingerprint) || origin.sourceConversationKey !== target.sourceKey ||
      normalized.conversationKey !== target.sourceKey || !Number.isSafeInteger(origin.ordinal) || origin.ordinal < 0 || origin.ordinal !== normalized.ordinal) invalid()
  return normalized
}
function classify(store: Store, target: ResolvedTarget, message: ParsedMessage, origin: SourceRecordKey): MessageClassification {
  if (target.conversationId === null) return 'new'
  const id = localId(target.conversationId), db = store.writer
  if (!db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)) invalid()
  if (message.originalId !== null && db.prepare('SELECT 1 FROM message_keys WHERE conversation_id=? AND id_namespace=? AND original_id=?').get(id, message.idNamespace, message.originalId)) return 'duplicate'
  if (db.prepare('SELECT 1 FROM message_origins WHERE conversation_id=? AND file_fingerprint=? AND source_conversation_key=? AND ordinal=?').get(id, origin.fingerprint, origin.sourceConversationKey, origin.ordinal)) return 'duplicate'
  if (message.originalId !== null) return 'new'
  // Matching text, names or timestamps cannot prove that two source records represent one message.
  if (db.prepare('SELECT 1 FROM message_origins WHERE conversation_id=? AND file_fingerprint!=? LIMIT 1').get(id, origin.fingerprint)) return 'ambiguous'
  if (db.prepare('SELECT 1 FROM messages m WHERE m.conversation_id=? AND NOT EXISTS (SELECT 1 FROM message_origins o WHERE o.message_id=m.id) LIMIT 1').get(id)) return 'ambiguous'
  return 'new'
}
/** Never mutates a saved message, its origins, attachments or replies. */
export function classifyMessage(store: Store, target: ResolvedTarget, message: ParsedMessage, origin: SourceRecordKey): MessageClassification {
  return classify(store, target, validateRecord(store, target, message, origin), origin)
}
/** Bounded batch helper; the merge caller must roll back the whole target group on any ambiguity. */
export function classifyBatch(store: Store, target: ResolvedTarget, records: readonly { message: ParsedMessage; origin: SourceRecordKey }[]): MessageClassification[] {
  const keys = new Set<string>(), origins = new Set<string>(), fingerprints = new Set<string>()
  return records.map(record => {
    const message = validateRecord(store, target, record.message, record.origin), origin = record.origin
    const key = message.originalId === null ? null : JSON.stringify([message.idNamespace, message.originalId])
    const source = JSON.stringify([origin.fingerprint, origin.sourceConversationKey, origin.ordinal])
    if ((key !== null && keys.has(key)) || origins.has(source)) return 'duplicate'
    let result = classify(store, target, message, origin)
    if (result === 'new' && message.originalId === null && [...fingerprints].some(f => f !== origin.fingerprint)) result = 'ambiguous'
    if (result !== 'ambiguous') { if (key !== null) keys.add(key); origins.add(source); fingerprints.add(origin.fingerprint) }
    return result
  })
}

/** Call only inside the service's shared writer queue, between import transactions. */
export function confirmSelf(store: Store, conversationId: LocalId, memberId: LocalId | null): void {
  const conversation = localId(conversationId), member = memberId === null ? null : localId(memberId), db = store.writer
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM conversations WHERE id=?').get(conversation) ||
        (member !== null && !db.prepare('SELECT 1 FROM memberships WHERE id=? AND conversation_id=?').get(member, conversation))) invalid()
    db.prepare("UPDATE self_confirmations SET status='revoked' WHERE conversation_id=? AND status='confirmed'").run(conversation)
    if (member === null) db.prepare('INSERT INTO self_opt_outs(conversation_id) VALUES (?) ON CONFLICT(conversation_id) DO NOTHING').run(conversation)
    else {
      db.prepare('DELETE FROM self_opt_outs WHERE conversation_id=?').run(conversation)
      db.prepare("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (?,?,'confirmed','user')").run(conversation, member)
    }
  })()
}
