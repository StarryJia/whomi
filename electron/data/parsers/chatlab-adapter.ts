import type { ParsedConversation, ParsedMember, ParsedMessage } from '../../../src/shared/conversation-model'
import type { FormatModule, ParsedMeta, ParsedMessage as UpMessage } from '../../vendor/chatlab-parser/src/types'
import { ChatType } from '../../vendor/chatlab-parser/shared-types'
import type { ParseEvent, ParserAdapter, ParserInput, SourceProbe } from './types'
import { checkCancelled, lines, parseJson, ParseFailure, recordLimit } from './input'
import { sourceConversations } from './source-records'
import type { Raw } from './source-records'
import { conversation, decodeInstagram, normalizeMessage } from './normalize'
import { sourceKey } from './siwx-normalizer'
import { withSnapshot } from './snapshot-fs'

function issue(input: ParserInput, code: string, severity: 'blocking' | 'warning' = 'blocking', ordinal?: number): ParseEvent {
  return { type: 'issue', value: { candidateId: input.candidateId, code, severity, ...(ordinal !== undefined ? { ordinal } : {}), action: code === 'cancelled' ? '导入已取消。' : severity === 'blocking' ? '请检查导出文件后重试。' : '请核对来源记录。' } }
}
function member(message: ParsedMessage, raw: Raw, chat: ParsedConversation, id: string): ParsedMember {
  const nameOnly = ['instagram-native', 'line-native', 'whatsapp-native'].includes(id) || (id === 'qq-native' && !raw.sender)
  return { sourceKey: message.senderKey!, displayName: message.senderName,
    stableAccountKey: nameOnly ? null : stableAccountKey(id, chat, message.senderKey!),
    selfHint: raw.isSend === 1 || (chat.identity.ownerKey !== null && chat.identity.ownerKey === message.senderKey) ? true : null }
}
function stableAccountKey(id: string, chat: ParsedConversation, key: string) {
  if (['instagram-native', 'line-native', 'whatsapp-native'].includes(id)) return null
  if (id.startsWith('chatlab') && !['qq', 'weixin', 'discord', 'telegram', 'google-chat'].includes(chat.identity.platform)) return null
  return key
}
function* declaredMemberEvents(rows: Raw[], chat: ParsedConversation, id: string, members: Set<string>): Generator<ParseEvent> {
  for (const row of rows) {
    const key = sourceKey(row.platformId)
    if (!key || members.has(key)) continue
    members.add(key)
    yield { type: 'member', conversationKey: chat.sourceKey, value: {
      sourceKey: key, displayName: row.groupNickname ?? row.accountName ?? key,
      stableAccountKey: stableAccountKey(id, chat, key), selfHint: chat.identity.ownerKey === key ? true : null,
    } }
  }
}
function* messageEvents(input: ParserInput, message: ParsedMessage, raw: Raw, chat: ParsedConversation, id: string, members: Set<string>): Generator<ParseEvent> {
  if (Buffer.byteLength(JSON.stringify(message)) > recordLimit(input)) throw new ParseFailure('record-limit', message.ordinal)
  if (message.senderKind === 'member' && !members.has(message.senderKey!)) {
    members.add(message.senderKey!)
    yield { type: 'member', conversationKey: chat.sourceKey, value: member(message, raw, chat, id) }
  }
  if (message.senderKind === 'unknown') yield issue(input, 'unknown-sender', 'warning', message.ordinal)
  if (message.sentAtMs === null) yield issue(input, 'unknown-time', 'warning', message.ordinal)
  if (message.kind === 'unknown') yield issue(input, 'unknown-type', 'warning', message.ordinal)
  yield { type: 'message', value: message }
}

async function* bounded(module: FormatModule, input: ParserInput): AsyncGenerator<ParseEvent> {
  const id = module.feature.id
  const sources = await sourceConversations(id, input)
  for (const source of sources) {
    checkCancelled(input)
    let meta: ParsedMeta = { name: '未命名会话', platform: module.feature.platform, type: ChatType.GROUP }
    const messages: UpMessage[] = []
    let done = false
    for await (const event of module.parser.parse({ filePath: input.entry, batchSize: 500, formatOptions: { chatIndex: source.chatIndex } })) {
      checkCancelled(input)
      if (event.type === 'meta') meta = event.data
      if (event.type === 'messages') messages.push(...event.data)
      if (event.type === 'error') throw new ParseFailure('upstream-error')
      if (event.type === 'done') done = true
    }
    if (!done) throw new ParseFailure('incomplete-parse')
    const chat = conversation(id, source.root, meta, source.chatIndex)
    yield { type: 'conversation', value: chat }
    const members = new Set<string>()
    if (id === 'chatlab') yield* declaredMemberEvents(source.root.members ?? [], chat, id, members)
    if (id === 'instagram-native') yield* declaredMemberEvents(source.root.participants.map((row: Raw) => ({
      platformId: decodeInstagram(row.name), accountName: decodeInstagram(row.name),
    })), chat, id, members)
    if (id === 'google-chat-native') {
      const declared = [...(source.root._group?.members ?? []), ...(source.root._user?.user ? [source.root._user.user] : [])]
      yield* declaredMemberEvents(declared.map(row => ({ platformId: row.email, accountName: row.name })), chat, id, members)
    }
    // Upstream Instagram reverses output; source ordinal continues to identify the original record.
    if (id === 'instagram-native') messages.reverse()
    if (messages.length !== source.records.length) {
      yield issue(input, 'upstream-skipped-records', 'warning')
    }
    const self = new Set(source.records.filter(row => row.isSend === 1).map(row => sourceKey(row.senderUsername)).filter(Boolean))
    const declaredOwner = sourceKey(source.root.exportInfo?.wxid ?? source.root.exportInfo?.username)
    if (self.size > 1 || (declaredOwner && self.size && !self.has(declaredOwner))) yield issue(input, 'owner-conflict', 'warning')
    for (let ordinal = 0; ordinal < source.records.length; ordinal++) {
      checkCancelled(input)
      const raw = source.records[ordinal]
      const parsed = messages.length === source.records.length ? messages[ordinal]
        : messages.find(m => m.platformMessageId && m.platformMessageId === sourceKey(raw.id ?? raw.messageId ?? raw.platformMessageId))
      const message = normalizeMessage(id, raw, parsed, chat, ordinal)
      yield* messageEvents(input, message, raw, chat, id, members)
      if (ordinal % 500 === 499) await new Promise<void>(resolve => setImmediate(resolve))
    }
    yield { type: 'end', conversationKey: chat.sourceKey, seen: source.records.length }
  }
}

async function* jsonl(module: FormatModule, input: ParserInput): AsyncGenerator<ParseEvent> {
  let root: Raw | undefined, chat: ParsedConversation | undefined, ordinal = 0, done = false
  const queued: Raw[] = [], declared: Raw[] = [], members = new Set<string>()
  async function* checkedLines() {
    for await (const line of lines(input)) {
      const trimmed = line.replace(/^\uFEFF/, '').trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      let raw: Raw
      try { raw = parseJson(trimmed) }
      catch { throw new ParseFailure('invalid-record', ordinal) }
      if (!root) {
        if (raw?._type !== 'header' || !raw.meta || !['0.0.1', '0.0.2'].includes(raw.chatlab?.version)) throw new ParseFailure('invalid-header')
        root = raw
      } else if (raw?._type === 'message') queued.push(raw)
      else if (raw?._type === 'member') declared.push(raw)
      else throw new ParseFailure('invalid-record', ordinal)
      yield trimmed
    }
    if (!root) throw new ParseFailure('invalid-header')
  }
  for await (const event of module.parser.parse({ filePath: input.entry, batchSize: 1, lines: checkedLines() })) {
    checkCancelled(input)
    if (event.type === 'meta') {
      chat = conversation(module.feature.id, root!, event.data, 0)
      yield { type: 'conversation', value: chat }
    }
    if (chat) yield* declaredMemberEvents(declared.splice(0), chat, module.feature.id, members)
    if (event.type === 'messages') {
      if (!chat) throw new ParseFailure('invalid-header')
      for (const value of event.data) {
        const raw = queued.shift()
        if (!raw) throw new ParseFailure('record-count-mismatch')
        const normalized = normalizeMessage(module.feature.id, raw, value, chat, ordinal++)
        yield* messageEvents(input, normalized, raw, chat, module.feature.id, members)
      }
    }
    if (event.type === 'error') throw new ParseFailure('upstream-error')
    if (event.type === 'done') done = true
  }
  if (!done || !chat || queued.length) throw new ParseFailure('incomplete-parse')
  yield { type: 'end', conversationKey: chat.sourceKey, seen: ordinal }
}

async function detect(module: FormatModule, probe: SourceProbe) {
  if (!module.feature.extensions.includes(probe.extension.toLowerCase()) || probe.size < 1) return 0
  const text = new TextDecoder().decode(probe.prefix.subarray(0, 65536))
  const signatures = module.feature.signatures
  if (!signatures.head?.some(regex => regex.test(text))) return 0
  if (signatures.requiredFields?.some(field => !new RegExp(`"${field}"\\s*:`).test(text))) return 0
  if (module.feature.id === 'qq-shuakami' && /chunked-jsonl/.test(text)) return 0
  return Math.max(1, 100 - module.feature.priority)
}

export function adapt(module: FormatModule): ParserAdapter {
  const stream = module.feature.id === 'chatlab-jsonl'
  return Object.freeze({
    id: module.feature.id, version: 'f19beeadda27b-whomi.1', extensions: Object.freeze([...module.feature.extensions]),
    mode: stream ? 'stream' : 'bounded',
    capabilities: { multiConversation: Boolean(module.feature.multiChat), stableMessageIds: ['qq-native', 'qq-shuakami', 'qq-shuakami-chunked', 'line-native', 'whatsapp-native', 'instagram-native'].includes(module.feature.id) ? 'none' : 'conditional', media: 'descriptors-only' },
    detect: (probe: SourceProbe) => detect(module, probe),
    async *parse(input: ParserInput): AsyncGenerator<ParseEvent> {
      try {
        checkCancelled(input)
        yield* withSnapshot(input, () => stream ? jsonl(module, input) : bounded(module, input))
      } catch (error) {
        const failure = error instanceof ParseFailure ? error : new ParseFailure(input.signal.aborted ? 'cancelled' : 'invalid-format')
        yield issue(input, failure.code, 'blocking', failure.ordinal)
      }
    },
  }) as ParserAdapter
}
