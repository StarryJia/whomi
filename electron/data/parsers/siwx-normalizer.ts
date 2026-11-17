import { SaxesParser } from 'saxes'
import type { MessageKind, ParsedMessage } from '../../../src/shared/conversation-model'

export const sourceKey = (value: unknown): string | null =>
  typeof value === 'string' ? value.length ? value : null : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null
export function epoch(value: unknown, unit: 'second' | 'millisecond'): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  const ms = unit === 'second' ? n * 1000 : n
  return Number.isSafeInteger(ms) ? ms : null
}
const named: Record<string, MessageKind> = {
  '文本消息': 'text', '文本': 'text', '图片消息': 'image', '图片': 'image', '语音消息': 'audio', '语音': 'audio',
  '视频消息': 'video', '视频': 'video', '文件消息': 'file', '文件': 'file', '动画表情': 'sticker',
  '引用消息': 'reply', '引用': 'reply', '聊天记录合并转发': 'forward', '系统消息': 'system', '系统': 'system',
  '位置消息': 'location', '卡片式链接': 'link', '图文消息': 'link',
  '名片消息': 'contact', '通话消息': 'call', '拍一拍': 'poke',
}
const numeric: Partial<Record<number, MessageKind>> = {
  1: 'text', 3: 'image', 34: 'audio', 42: 'contact', 43: 'video', 47: 'sticker', 48: 'location',
  50: 'call', 10000: 'system', 10002: 'system',
}
const applicationKinds: Partial<Record<number, MessageKind>> = {
  4: 'link', 5: 'link', 6: 'file', 8: 'sticker', 19: 'forward', 57: 'reply', 62: 'poke',
}
const applicationTypeBase = 2 ** 32

function typeNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function readSiwxPayload(content: unknown) {
  if (typeof content !== 'string' || !content.trim()) return null
  const parser = new SaxesParser({ position: false, xmlns: false as const })
  const path: string[] = []
  const typeField = { count: 0, text: '' }
  const referenceField = { count: 0, text: '' }
  let field: typeof typeField | undefined
  let applications = 0, references = 0, attributeType: string | undefined
  const rejectPayload = () => { throw new Error('Invalid WeChat message XML') }
  const appendField = (text: string) => { if (field) field.text += text }

  parser.on('doctype', rejectPayload)
  parser.on('opentag', tag => {
    if (field || path.length === 128) rejectPayload()
    path.push(tag.name)
    const applicationDepth = path[0] === 'msg' && path[1] === 'appmsg' ? 2 : path[0] === 'appmsg' ? 1 : 0
    const referenceDepth = path[0] === 'refermsg' ? 1
      : applicationDepth && path[applicationDepth] === 'refermsg' ? applicationDepth + 1 : 0
    if (applicationDepth && path.length === applicationDepth) {
      applications++
      attributeType = tag.attributes.type
    }
    if (referenceDepth && path.length === referenceDepth) references++
    if (applicationDepth && path.length === applicationDepth + 1 && tag.name === 'type') field = typeField
    if (referenceDepth && path.length === referenceDepth + 1 && tag.name === 'svrid') field = referenceField
    if (field) field.count++
  })
  parser.on('closetag', () => {
    field = undefined
    path.pop()
  })
  parser.on('text', appendField)
  parser.on('cdata', appendField)
  try {
    // SIWX keeps the group sender envelope in rawContent.
    parser.write(content.replace(/^[a-zA-Z0-9_-]+:\r?\n/, '')).close()
  } catch {
    return null
  }

  const elementType = typeNumber(typeField.text.trim())
  const attribute = typeNumber(attributeType?.trim())
  let subtype: number | undefined
  if (applications === 1) {
    if (typeField.count === 1 && (attributeType === undefined || attribute === elementType)) subtype = elementType
    if (typeField.count === 0 && attribute === 19) subtype = attribute
  }
  const serverId = referenceField.text.trim()
  return {
    subtype,
    replyId: applications <= 1 && references === 1 && referenceField.count === 1 && /^[1-9]\d*$/.test(serverId) ? serverId : null,
  }
}

export function siwxKind(raw: Record<string, any>): MessageKind {
  if (siwxQuote(raw)) return 'reply'
  const label = sourceKey(raw.typeName ?? raw.type)
  if (label && Object.hasOwn(named, label)) return named[label]
  const localType = typeNumber(raw.localType)
  const isApplicationType = localType !== undefined && localType % applicationTypeBase === 49
  if (isApplicationType || label === '链接/文件') {
    const packedSubtype = isApplicationType ? Math.floor(localType / applicationTypeBase) : 0
    if (typeof raw.rawContent === 'string' && raw.rawContent.trim()) {
      const subtype = readSiwxPayload(raw.rawContent)?.subtype
      if (subtype === undefined || (packedSubtype && packedSubtype !== subtype)) return 'unknown'
      return applicationKinds[subtype] ?? 'unknown'
    }
    if (packedSubtype) return applicationKinds[packedSubtype] ?? 'unknown'
    return 'unknown'
  }
  return localType === undefined ? 'unknown' : numeric[localType] ?? 'unknown'
}

function siwxQuote(raw: Record<string, any>) {
  const quote = raw.quote
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return null
  const hasExcerpt = typeof quote.content === 'string'
  const hasSender = sourceKey(quote.senderName ?? quote.displayName ?? quote.displayname) !== null
  const hasTime = epoch(quote.createTime ?? quote.ts, 'second') !== null
  return hasExcerpt || hasSender || hasTime ? quote : null
}
export function normalizeSiwx(raw: Record<string, any>, base: ParsedMessage): ParsedMessage {
  const kind = siwxKind(raw)
  const sender = sourceKey(raw.senderUsername)
  // SIWX/WeFlow numeric createTime exports may use either epoch unit.
  const unit = Math.abs(Number(raw.createTime)) >= 100_000_000_000 ? 'millisecond' : 'second'
  const sentAtMs = epoch(raw.createTime, unit)
  const originalId = sourceKey(raw.serverId ?? raw.platformMessageId)
  const quote = siwxQuote(raw)
  const replyId = quote ? readSiwxPayload(raw.rawContent)?.replyId ?? null : null
  return {
    ...base, originalId: originalId === '0' ? null : originalId,
    idNamespace: originalId && originalId !== '0' ? 'wechat:server-message' : null,
    senderKey: kind === 'system' ? null : sender,
    senderKind: kind === 'system' ? 'system' : sender ? 'member' : 'unknown',
    senderName: typeof raw.senderDisplayName === 'string' && raw.senderDisplayName ? raw.senderDisplayName : sender ?? '未知发送者',
    sentAtMs, timeRaw: sourceKey(raw.formattedTime) ?? sourceKey(raw.createTime),
    timePrecision: sentAtMs === null ? 'unknown' : unit, timezone: sentAtMs === null ? null : 'UTC', kind,
    text: typeof raw.content === 'string' ? raw.content : raw.content == null ? '' : JSON.stringify(raw.content),
    sourceType: sourceKey(raw.typeName ?? raw.type ?? raw.localType),
    reply: quote ? { originalId: replyId, idNamespace: replyId ? 'wechat:server-message' : null, text: typeof quote.content === 'string' ? quote.content : null, senderName: sourceKey(quote.senderName ?? quote.displayName ?? quote.displayname), sentAtMs: epoch(quote.createTime ?? quote.ts, 'second') } : null,
    attachments: ['image', 'audio', 'video', 'file', 'sticker'].includes(kind)
      ? [{ kind, locator: sourceKey(raw.mediaFile), name: null, state: raw.mediaFile ? 'unresolved' : 'missing' }] : [],
    extra: { ...(raw.localType !== undefined ? { localType: raw.localType } : {}), ...(raw.isSend === 1 ? { selfHint: true } : {}) },
  }
}
