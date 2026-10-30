import type { MessageKind, ParsedConversation, ParsedMessage } from '../../../src/shared/conversation-model'
import { normalizeModel } from '../../../src/shared/conversation-model'
import type { ParsedMessage as UpMessage, ParsedMeta } from '../../vendor/chatlab-parser/src/types'
import { parseGoogleChatDate } from '../../vendor/chatlab-parser/src/formats/google-chat-takeout'
import { detectMessageType } from '../../vendor/chatlab-parser/src/formats/utils/telegram-utils'
import type { TelegramMessage } from '../../vendor/chatlab-parser/src/formats/utils/telegram-utils'
import { epoch, normalizeSiwx, sourceKey } from './siwx-normalizer'
import type { Raw } from './source-records'

const kinds: Record<number, MessageKind> = { 0: 'text', 1: 'image', 2: 'audio', 3: 'video', 4: 'file', 5: 'sticker', 7: 'link', 8: 'location', 25: 'reply', 26: 'forward', 80: 'system', 81: 'system', 99: 'unknown' }
export function conversation(id: string, root: Raw, meta: ParsedMeta, index: number): ParsedConversation {
  const platform = meta.platform
  const owner = root.meta?.ownerId ?? root.chatInfo?.selfUin ?? root.chatInfo?.selfUid ?? root.personal_information?.user_id ?? root._user?.user?.email ?? meta.ownerId ?? null
  const key = root.meta?.groupId ?? root.meta?.sourceSessionId ?? root.session?.wxid ?? root.channel?.id ?? (id.startsWith('telegram-') ? root.id : null) ?? root.chatId ?? meta.groupId ?? meta.sourceSessionId ?? null
  const source = `${id}:${index}`
  return { sourceKey: source, title: root.meta?.name ?? root.session?.displayName ?? meta.name ?? '未命名会话', kind: meta.type === 'private' ? 'direct' : meta.type === 'group' ? 'group' : 'unknown', identity: { platform, ownerKey: sourceKey(owner), conversationKey: sourceKey(key), namespace: id.startsWith('telegram-') ? 'telegram' : id.startsWith('chatlab') ? 'chatlab' : id === 'echotrace' || id === 'weflow' ? 'wechat' : id } }
}

export function normalizeMessage(id: string, raw: Raw, parsed: UpMessage | undefined, chat: ParsedConversation, ordinal: number): ParsedMessage {
  let message: ParsedMessage = {
    modelVersion: 1, conversationKey: chat.sourceKey, ordinal, originalId: null, idNamespace: null,
    senderKey: sourceKey(parsed?.senderPlatformId), senderKind: parsed?.senderPlatformId ? 'member' : 'unknown',
    senderName: parsed?.senderGroupNickname ?? parsed?.senderAccountName ?? '未知发送者',
    sentAtMs: null, timeRaw: null, timePrecision: 'unknown', timezone: null,
    kind: parsed ? kinds[parsed.type] ?? 'unknown' : 'unknown', text: parsed?.content ?? '', sourceType: sourceKey(raw.type ?? raw.messageType), reply: null, attachments: [], extra: {},
  }
  let original: unknown = null, replyId: unknown = null, namespace: string | null = null
  if (id === 'echotrace' || id === 'weflow') return normalizeModel(normalizeSiwx(raw, message))
  if (id.startsWith('chatlab')) {
    message.text = typeof raw.content === 'string' ? raw.content : raw.content == null ? '' : JSON.stringify(raw.content)
    message.kind = kinds[raw.type] ?? 'unknown'
    message.senderKey = sourceKey(raw.sender)
    message.senderName = raw.groupNickname ?? raw.accountName ?? message.senderKey ?? '未知发送者'
    message.sentAtMs = epoch(raw.timestamp, 'second'); message.timeRaw = sourceKey(raw.timestamp)
    message.timePrecision = 'second'; message.timezone = 'UTC'
    original = raw.platformMessageId; replyId = raw.replyToMessageId
    namespace = ['discord', 'telegram', 'google-chat'].includes(chat.identity.platform) ? `${chat.identity.platform}:message` : null
  } else if (id.startsWith('telegram-')) {
    message.text = typeof raw.text === 'string' ? raw.text : Array.isArray(raw.text) ? raw.text.map((x: any) => typeof x === 'string' ? x : x?.text ?? '').join('') : ''
    message.senderKey = sourceKey(raw.from_id ?? raw.actor_id)
    message.senderName = raw.from ?? raw.actor ?? '未知发送者'
    message.kind = raw.type === 'service' ? 'system' : raw.media_type === 'sticker' ? 'sticker' : raw.type !== 'message' ? 'unknown' : kinds[detectMessageType(raw as TelegramMessage)] ?? 'unknown'
    message.sentAtMs = epoch(raw.date_unixtime, 'second'); message.timeRaw = sourceKey(raw.date) ?? sourceKey(raw.date_unixtime)
    message.timePrecision = 'second'; message.timezone = 'UTC'
    original = raw.id; replyId = raw.reply_to_message_id; namespace = 'telegram:message'
    if (raw.action) message.extra.action = raw.action
    if (raw.forwarded_from) { message.extra.forwardedFrom = raw.forwarded_from; if (message.kind === 'text') message.kind = 'forward' }
    if (raw.photo || raw.file) message.attachments.push({ kind: message.kind, locator: sourceKey(raw.photo ?? raw.file), name: sourceKey(raw.file_name), state: 'unresolved' })
  } else if (id === 'discord-tyrrrz') {
    message.text = typeof raw.content === 'string' ? raw.content : ''
    message.senderKey = sourceKey(raw.author?.id); message.senderName = raw.author?.nickname ?? raw.author?.name ?? '未知发送者'
    message.sentAtMs = typeof raw.timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(raw.timestamp) ? Date.parse(raw.timestamp) : null
    message.timeRaw = sourceKey(raw.timestamp); message.timePrecision = 'millisecond'; message.timezone = message.sentAtMs === null ? null : raw.timestamp.match(/(?:Z|[+-]\d{2}:\d{2})$/)?.[0] ?? null
    original = raw.id; replyId = raw.reference?.messageId; namespace = 'discord:message'
    if (!['Default', 'Reply', 'RecipientAdd', 'RecipientRemove', 'Call', 'ChannelNameChange', 'ChannelIconChange', 'ChannelPinnedMessage', 'GuildMemberJoin'].includes(raw.type)) message.kind = 'unknown'
    for (const a of raw.attachments ?? []) message.attachments.push({ kind: 'file', locator: sourceKey(a.url), name: sourceKey(a.fileName), state: a.url ? 'unresolved' : 'missing' })
  } else if (id === 'instagram-native') {
    message.text = decodeInstagram(raw.content ?? '')
    message.senderKey = sourceKey(decodeInstagram(raw.sender_name ?? '')); message.senderName = message.senderKey ?? '未知发送者'
    message.sentAtMs = epoch(raw.timestamp_ms, 'millisecond'); message.timeRaw = sourceKey(raw.timestamp_ms); message.timePrecision = 'millisecond'; message.timezone = 'UTC'
    if (raw.share) message.attachments.push({ kind: 'link', locator: sourceKey(raw.share.link),
      name: typeof raw.share.share_text === 'string' ? decodeInstagram(raw.share.share_text) : null,
      state: raw.share.link ? 'unresolved' : 'missing' })
    for (const [field, kind] of [['photos','image'], ['videos','video'], ['audio_files','audio']] as const)
      for (const a of raw[field] ?? []) message.attachments.push({ kind, locator: sourceKey(a.uri), name: null, state: a.uri ? 'unresolved' : 'missing' })
  } else if (id === 'google-chat-native') {
    message.text = typeof raw.text === 'string' ? raw.text : ''
    message.senderKey = sourceKey(raw.creator?.email); message.senderName = raw.creator?.name ?? raw.creator?.email ?? '未知发送者'
    message.sentAtMs = epoch(parseGoogleChatDate(raw.created_date ?? raw.updated_date ?? ''), 'second'); message.timeRaw = sourceKey(raw.created_date ?? raw.updated_date); message.timePrecision = 'second'; message.timezone = 'UTC'
    original = raw.message_id; namespace = 'google-chat:message'
    const quote = raw.quoted_message_metadata
    if (quote) message.reply = { originalId: null, idNamespace: null, text: typeof quote.text === 'string' ? quote.text : null, senderName: sourceKey(quote.creator?.name), sentAtMs: null }
    for (const a of raw.attached_files ?? []) message.attachments.push({ kind: 'file', locator: sourceKey(a.export_name), name: sourceKey(a.original_name), state: a.export_name ? 'unresolved' : 'missing' })
  } else if (id.startsWith('qq-shuakami')) {
    message.text = typeof raw.content?.text === 'string' ? raw.content.text : ''
    message.senderKey = sourceKey(raw.sender?.uin ?? raw.sender?.uid); message.senderName = raw.sender?.name ?? '未知发送者'
    const t = raw.timestamp
    message.timeRaw = sourceKey(raw.time ?? t)
    const unit = 'millisecond'
    message.sentAtMs = typeof t === 'number' ? epoch(t, unit) : typeof t === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(t) ? Date.parse(t) : null
    message.timePrecision = unit; message.timezone = message.sentAtMs === null ? null : 'UTC'
    if (raw.system || raw.isSystemMessage) message.kind = 'system'
    // Export-local id/seq/messageId are not proven stable across independent exports.
    const quote = raw.content?.reply
    if (quote) message.reply = { originalId: null, idNamespace: null, text: sourceKey(quote.content), senderName: sourceKey(quote.senderName), sentAtMs: null }
    if (raw.type && !['text', 'system', 'image', 'video', 'audio', 'voice', 'file'].includes(raw.type)) message.kind = 'unknown'
  } else {
    message.text = raw.content
    message.timeRaw = sourceKey(raw.time)
    message.senderKey = sourceKey(raw.sender) ?? (raw.name ? `local-name:${raw.name}` : null)
    message.senderName = raw.name ?? '未知发送者'
    if (raw.system) message.kind = 'system'
  }
  message.originalId = namespace ? sourceKey(original) : null
  message.idNamespace = message.originalId ? namespace : null
  if (sourceKey(replyId) && namespace) message.reply = { originalId: sourceKey(replyId), idNamespace: namespace, text: null, senderName: null, sentAtMs: null }
  if (message.reply) message.kind = 'reply'
  if (!Number.isSafeInteger(message.sentAtMs)) message.sentAtMs = null
  if (message.sentAtMs === null) { message.timePrecision = 'unknown'; message.timezone = null }
  message.senderKind = message.kind === 'system' ? 'system' : message.senderKey ? 'member' : 'unknown'
  if (message.senderKind !== 'member') message.senderKey = null
  if (!message.attachments.length && ['image', 'audio', 'video', 'file', 'sticker'].includes(message.kind)) message.attachments.push({ kind: message.kind, locator: null, name: null, state: 'missing' })
  return normalizeModel(message)
}

export function decodeInstagram(text: string) {
  if ([...text].some(char => char.charCodeAt(0) > 255)) return text
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, char => char.charCodeAt(0))) }
  catch { return text }
}
