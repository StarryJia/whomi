import type { MessageKind, ParsedMessage } from '../../../src/shared/conversation-model'

export const sourceKey = (value: unknown): string | null =>
  typeof value === 'string' ? value.length ? value : null : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null
export function epoch(value: unknown, unit: 'second' | 'millisecond'): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  const ms = unit === 'second' ? n * 1000 : n
  return Number.isSafeInteger(ms) ? ms : null
}
export function siwxKind(raw: Record<string, any>): MessageKind {
  const named: Record<string, MessageKind> = {
    '文本消息': 'text', '文本': 'text', '图片消息': 'image', '图片': 'image', '语音消息': 'audio', '语音': 'audio',
    '视频消息': 'video', '视频': 'video', '文件消息': 'file', '文件': 'file', '动画表情': 'sticker',
    '引用消息': 'reply', '引用': 'reply', '聊天记录合并转发': 'forward', '系统消息': 'system', '系统': 'system',
    '位置消息': 'location', '卡片式链接': 'link', '图文消息': 'link',
  }
  if (raw.quote && typeof raw.quote === 'object' && Object.keys(raw.quote).length) return 'reply'
  if (named[raw.typeName ?? raw.type]) return named[raw.typeName ?? raw.type]
  const numeric: Record<string, MessageKind> = { '1': 'text', '3': 'image', '34': 'audio', '43': 'video', '47': 'sticker', '48': 'location', '10000': 'system', '10002': 'system' }
  return numeric[String(raw.localType)] ?? 'unknown'
}
function referencedServerId(rawContent: unknown): string | null {
  if (typeof rawContent !== 'string') return null
  const block = rawContent.match(/<refermsg(?:\s[^>]*)?>([\s\S]*?)<\/refermsg>/)?.[1]
  const field = block?.match(/<svrid>([\s\S]*?)<\/svrid>/)?.[1].trim()
  const value = field?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim()
  return value && /^[1-9]\d*$/.test(value) ? value : null
}
export function normalizeSiwx(raw: Record<string, any>, base: ParsedMessage): ParsedMessage {
  const kind = siwxKind(raw)
  const sender = sourceKey(raw.senderUsername)
  // SIWX/WeFlow numeric createTime exports may use either epoch unit.
  const unit = Math.abs(Number(raw.createTime)) >= 100_000_000_000 ? 'millisecond' : 'second'
  const sentAtMs = epoch(raw.createTime, unit)
  const originalId = sourceKey(raw.serverId ?? raw.platformMessageId)
  const quote = raw.quote && typeof raw.quote === 'object' && Object.keys(raw.quote).length ? raw.quote : null
  const replyId = quote ? referencedServerId(raw.rawContent) : null
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
