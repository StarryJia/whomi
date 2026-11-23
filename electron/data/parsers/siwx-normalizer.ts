import { SaxesParser } from 'saxes'
import type { MessageKind, ParsedMessage, ParsedReply } from '../../../src/shared/conversation-model'
import type { SiwxCompatibility } from './types'
import { hasWechatRecallMarker } from './wechat-recall'

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
  4: 'link', 5: 'link', 6: 'file', 8: 'sticker', 19: 'forward', 36: 'link', 57: 'reply', 62: 'poke', 76: 'link',
}
const applicationTypeBase = 2 ** 32

export type UnknownTypeDetail = { reason: string; type?: number; subtype?: number; alternateSubtype?: number }
type ReportUnknownType = (detail: UnknownTypeDetail) => void

function unknownKind(report: ReportUnknownType | undefined, detail: UnknownTypeDetail): MessageKind {
  report?.(detail)
  return 'unknown'
}

function typeNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function withoutTrailingNullPadding(content: string): string {
  let end = content.length
  while (end > 0 && ' \r\n\t'.includes(content[end - 1])) end--
  const paddingEnd = end
  while (end > 0 && content[end - 1] === '\0') end--
  return end === paddingEnd ? content : content.slice(0, end)
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
  let subtypeProblem: UnknownTypeDetail | undefined
  if (subtype === undefined) {
    if (applications > 1 || typeField.count > 1 || (typeField.count === 1 && (!elementType || (attributeType !== undefined && !attribute)))) {
      subtypeProblem = { reason: '应用消息格式无效' }
    } else if (typeField.count === 1 && elementType && attribute) {
      subtypeProblem = { reason: '应用消息子类型冲突', subtype: elementType, alternateSubtype: attribute }
    } else {
      subtypeProblem = { reason: '缺少应用消息子类型' }
    }
  }
  const serverId = referenceField.text.trim()
  return {
    subtype,
    subtypeProblem,
    replyId: applications <= 1 && references === 1 && referenceField.count === 1 && /^[1-9]\d*$/.test(serverId) ? serverId : null,
  }
}

export function siwxKind(raw: Record<string, any>, report?: ReportUnknownType, markExpandedShare?: () => void): MessageKind {
  if (siwxQuote(raw)) return 'reply'
  const label = sourceKey(raw.typeName ?? raw.type)
  const localType = typeNumber(raw.localType)
  if (hasWechatRecallMarker(label, localType, raw.content)) return 'system'
  if (label && Object.hasOwn(named, label)) return named[label]
  const isApplicationType = localType !== undefined && localType % applicationTypeBase === 49
  const type = isApplicationType ? 49 : localType
  if (isApplicationType || label === '链接/文件') {
    const packedSubtype = isApplicationType ? Math.floor(localType / applicationTypeBase) : 0
    let subtype = packedSubtype
    let padded = false
    if (typeof raw.rawContent === 'string' && raw.rawContent.trim()) {
      const xml = withoutTrailingNullPadding(raw.rawContent)
      const payload = readSiwxPayload(xml)
      if (!payload) return unknownKind(report, { reason: '应用消息格式无效', type })
      if (xml !== raw.rawContent) {
        // 已核实导出工具会为分享链接和表情附加尾部空字符。
        const paddedKind = payload.subtype === undefined ? undefined : applicationKinds[payload.subtype]
        if (paddedKind !== 'link' && paddedKind !== 'sticker') return unknownKind(report, { reason: '应用消息格式无效', type })
        padded = true
      }
      if (payload.subtype === undefined) return unknownKind(report, { ...payload.subtypeProblem!, type })
      subtype = payload.subtype
      if (packedSubtype && packedSubtype !== subtype) {
        return unknownKind(report, { reason: '应用消息子类型冲突', type, subtype, alternateSubtype: packedSubtype })
      }
    }
    if (!subtype) return unknownKind(report, { reason: '缺少应用消息子类型', type })
    if (padded || subtype === 36 || subtype === 76) markExpandedShare?.()
    return applicationKinds[subtype] ?? unknownKind(report, { reason: '应用消息子类型尚未支持', type, subtype })
  }
  const kind = localType === undefined ? undefined : numeric[localType]
  if (kind) return kind
  if (localType !== undefined && label === `类型${localType}` && raw.content === `[${label}]` &&
      (typeof raw.rawContent !== 'string' || !raw.rawContent.trim())) {
    return unknownKind(report, { reason: '导出正文为类型占位', type })
  }
  return unknownKind(report, { reason: label || localType ? '消息类型尚未支持' : '缺少消息类型', type })
}

function siwxQuote(raw: Record<string, any>) {
  const quote = raw.quote
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return null
  const hasExcerpt = typeof quote.content === 'string'
  const hasSender = sourceKey(quote.senderName ?? quote.displayName ?? quote.displayname) !== null
  const hasTime = epoch(quote.createTime ?? quote.ts, 'second') !== null
  return hasExcerpt || hasSender || hasTime ? quote : null
}

function parsedReply(quote: Record<string, any>, replyId: string | null): ParsedReply {
  return {
    originalId: replyId, idNamespace: replyId ? 'wechat:server-message' : null,
    text: typeof quote.content === 'string' ? quote.content : null,
    senderName: sourceKey(quote.senderName ?? quote.displayName ?? quote.displayname),
    sentAtMs: epoch(quote.createTime ?? quote.ts, 'second'),
  }
}

// Match the old parser's first reference and field without restarting a scan for each unclosed tag.
function previousReferenceId(content: unknown): string | null {
  if (typeof content !== 'string') return null
  const lastClose = content.lastIndexOf('</refermsg>')
  if (lastClose < 0) return null
  const lastOpenEnd = content.lastIndexOf('>', lastClose - 1)
  const open = /<refermsg(?:\s[^>]*)?>/.exec(content.slice(0, lastOpenEnd + 1))
  if (!open) return null
  const start = open.index + open[0].length
  const close = content.indexOf('</refermsg>', start)
  const fieldStart = content.indexOf('<svrid>', start)
  if (fieldStart < 0 || fieldStart >= close) return null
  const valueStart = fieldStart + '<svrid>'.length
  const fieldEnd = content.indexOf('</svrid>', valueStart)
  if (fieldEnd < 0 || fieldEnd >= close) return null
  const field = content.slice(valueStart, fieldEnd).trim()
  const id = field.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim()
  return /^[1-9]\d*$/.test(id) ? id : null
}

function previousSiwxReply(raw: Record<string, any>, message: ParsedMessage): ParsedReply | undefined {
  if (message.originalId !== null) return
  const id = previousReferenceId(raw.rawContent)
  if (message.reply && message.reply.originalId === id) return
  return parsedReply(raw.quote, id)
}

function previousSiwxKind(raw: Record<string, any>, hadQuote: boolean): MessageKind {
  if (hadQuote) return 'reply'
  const label = raw.typeName ?? raw.type
  const namedKind = typeof label === 'string' && Object.hasOwn(named, label) ? named[label] : undefined
  if (namedKind && namedKind !== 'contact' && namedKind !== 'call' && namedKind !== 'poke') return namedKind
  const type = raw.localType
  // The older numeric lookup used the original key, without normalizing leading zeroes.
  if (type === 42 || type === '42' || type === 50 || type === '50') return 'unknown'
  return typeof type === 'number' || typeof type === 'string'
    ? (Object.hasOwn(numeric, type) ? numeric[type as number] ?? 'unknown' : 'unknown') : 'unknown'
}

export function normalizeSiwx(raw: Record<string, any>, base: ParsedMessage, reportUnknownType?: ReportUnknownType,
  reportCompatibility?: (value: SiwxCompatibility) => void): ParsedMessage {
  let expandedShare = false
  const kind = siwxKind(raw, reportUnknownType, () => { expandedShare = true })
  const sender = sourceKey(raw.senderUsername)
  // SIWX/WeFlow numeric createTime exports may use either epoch unit.
  const unit = Math.abs(Number(raw.createTime)) >= 100_000_000_000 ? 'millisecond' : 'second'
  const sentAtMs = epoch(raw.createTime, unit)
  const originalId = sourceKey(raw.serverId ?? raw.platformMessageId)
  const quote = siwxQuote(raw)
  const replyId = quote ? readSiwxPayload(raw.rawContent)?.replyId ?? null : null
  const message: ParsedMessage = {
    ...base, originalId: originalId === '0' ? null : originalId,
    idNamespace: originalId && originalId !== '0' ? 'wechat:server-message' : null,
    senderKey: kind === 'system' ? null : sender,
    senderKind: kind === 'system' ? 'system' : sender ? 'member' : 'unknown',
    senderName: kind === 'system' ? '' : typeof raw.senderDisplayName === 'string' && raw.senderDisplayName ? raw.senderDisplayName : sender ?? '未知发送者',
    sentAtMs, timeRaw: sourceKey(raw.formattedTime) ?? sourceKey(raw.createTime),
    timePrecision: sentAtMs === null ? 'unknown' : unit, timezone: sentAtMs === null ? null : 'UTC', kind,
    text: typeof raw.content === 'string' ? raw.content : raw.content == null ? '' : JSON.stringify(raw.content),
    sourceType: sourceKey(raw.typeName ?? raw.type ?? raw.localType),
    reply: quote ? parsedReply(quote, replyId) : null,
    attachments: ['image', 'audio', 'video', 'file', 'sticker'].includes(kind)
      ? [{ kind, locator: sourceKey(raw.mediaFile), name: null, state: raw.mediaFile ? 'unresolved' : 'missing' }] : [],
    extra: { ...(raw.localType !== undefined ? { localType: raw.localType } : {}), ...(kind !== 'system' && raw.isSend === 1 ? { selfHint: true } : {}) },
  }
  if (reportCompatibility) {
    const hadQuote = Boolean(raw.quote && typeof raw.quote === 'object' && Object.keys(raw.quote).length)
    const previousKind = previousSiwxKind(raw, hadQuote)
    const previousReply = hadQuote ? previousSiwxReply(raw, message) : undefined
    if (previousKind !== kind || expandedShare || previousReply) {
      reportCompatibility({
        kindBeforeTypeExpansion: previousKind === kind ? undefined : previousKind,
        kindBeforeShareExpansion: expandedShare ? 'unknown' : undefined,
        previousReply,
      })
    }
  }
  return message
}
