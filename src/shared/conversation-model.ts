export type LocalId = string
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'file' | 'sticker' | 'link' | 'location' | 'reply' | 'forward' | 'system' | 'unknown'
export type SourceIdentity = { platform: string; ownerKey: string | null; conversationKey: string | null; namespace: string }
export type ParsedMember = { sourceKey: string; displayName: string; stableAccountKey: string | null; selfHint: boolean | null }
export type ParsedConversation = { sourceKey: string; title: string; kind: 'direct' | 'group' | 'unknown'; identity: SourceIdentity }
export type ParsedReply = { originalId: string | null; idNamespace: string | null; text: string | null; senderName: string | null; sentAtMs: number | null }
export type ParsedAttachment = { kind: MessageKind; locator: string | null; name: string | null; state: 'unresolved' | 'missing' }
export type ParsedMessage = { modelVersion: 1; conversationKey: string; ordinal: number; originalId: string | null; idNamespace: string | null; senderKey: string | null; senderKind: 'member' | 'system' | 'unknown'; senderName: string; sentAtMs: number | null; timeRaw: string | null; timePrecision: 'millisecond' | 'second' | 'minute' | 'unknown'; timezone: string | null; kind: MessageKind; text: string; sourceType: string | null; reply: ParsedReply | null; attachments: ParsedAttachment[]; extra: Record<string, unknown> }
export type ImportIssue = { code: string; severity: 'warning' | 'blocking'; candidateId: string; ordinal?: number; action: string }
const kinds = new Set(['text','image','audio','video','file','sticker','link','location','reply','forward','system','unknown'])
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function nullableText(value: unknown) { return value === null || typeof value === 'string' }
function time(value: unknown) { return value === null || (typeof value === 'number' && Number.isSafeInteger(value)) }
function sourcePair(id: unknown, namespace: unknown) {
  return (id === null && namespace === null) ||
    (typeof id === 'string' && id.length > 0 && typeof namespace === 'string' && namespace.length > 0)
}
function invalid(): never { throw new Error('记录格式无效，请检查导入文件。') }
export function normalizeModel(input: unknown): ParsedMessage {
  if (!record(input)) invalid()
  const m = input
  if (m.modelVersion !== 1 || typeof m.conversationKey !== 'string' || !m.conversationKey || !Number.isSafeInteger(m.ordinal) || (m.ordinal as number) < 0) invalid()
  for (const key of ['originalId', 'idNamespace', 'senderKey', 'timeRaw', 'timezone', 'sourceType']) {
    if (!nullableText(m[key])) invalid()
  }
  if (!sourcePair(m.originalId, m.idNamespace)) invalid()
  if (!['member', 'system', 'unknown'].includes(m.senderKind as string) ||
      typeof m.senderName !== 'string' || typeof m.text !== 'string' || !time(m.sentAtMs) ||
      !['millisecond', 'second', 'minute', 'unknown'].includes(m.timePrecision as string) ||
      !kinds.has(m.kind as string)) invalid()
  if (m.senderKind === 'member' && (typeof m.senderKey !== 'string' || !m.senderKey)) invalid()
  if (m.reply !== null) {
    if (!record(m.reply)) invalid()
    for (const key of ['originalId', 'idNamespace', 'text', 'senderName']) {
      if (!nullableText(m.reply[key])) invalid()
    }
    if (!time(m.reply.sentAtMs) || !sourcePair(m.reply.originalId, m.reply.idNamespace)) invalid()
  }
  if (!Array.isArray(m.attachments) || !record(m.extra)) invalid()
  for (const a of m.attachments) {
    if (!record(a) || !kinds.has(a.kind as string) || !nullableText(a.locator) ||
        !nullableText(a.name) || !['unresolved', 'missing'].includes(a.state as string)) invalid()
  }
  // 只复制规范化字段，避免来源文件的其他字段进入内部模型。
  return {
    modelVersion: 1, conversationKey: m.conversationKey, ordinal: m.ordinal,
    originalId: m.originalId, idNamespace: m.idNamespace,
    senderKey: m.senderKey, senderKind: m.senderKind, senderName: m.senderName,
    sentAtMs: m.sentAtMs, timeRaw: m.timeRaw, timePrecision: m.timePrecision, timezone: m.timezone,
    kind: m.kind, text: m.text, sourceType: m.sourceType,
    reply: m.reply, attachments: m.attachments, extra: m.extra,
  } as ParsedMessage
}
