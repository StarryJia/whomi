import { importJobStates, importResultStates } from './import-contract'
import type { ImportSnapshot } from './import-contract'
import type { DesktopError, DesktopMethod } from './desktop-api'

type Check = (value: unknown) => boolean
const text: Check = value => typeof value === 'string' && value.length <= 8 * 1024 ** 2
const key: Check = value => typeof value === 'string' && value.length > 0 && value.length <= 128
const bool: Check = value => typeof value === 'boolean'
const integer: Check = value => typeof value === 'number' && Number.isSafeInteger(value)
const count: Check = value => integer(value) && (value as number) >= 0
const oneOf = (...choices: readonly unknown[]): Check => value => choices.includes(value)
const nullable = (check: Check): Check => value => value === null || check(value)
const optional = (check: Check): Check => value => value === undefined || check(value)
const array = (check: Check, max = Infinity): Check => value => Array.isArray(value) && value.length <= max && value.every(check)
const object = (fields: Record<string, Check>): Check => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).every(name => Object.hasOwn(fields, name)) && Object.entries(fields).every(([name, check]) => check(record[name]))
}
export const localId: Check = value => typeof value === 'string' && value.length <= 19 && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n
const zeroId: Check = value => value === '0' || localId(value)
const cursor: Check = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(value)
const limit = (max: number): Check => value => count(value) && (value as number) >= 1 && (value as number) <= max
const kind = oneOf('text', 'image', 'audio', 'video', 'file', 'sticker', 'link', 'location', 'reply', 'forward', 'system', 'unknown')
const chatKind = oneOf('direct', 'group', 'unknown')
const senderKind = oneOf('member', 'system', 'unknown')
const precision = oneOf('millisecond', 'second', 'minute', 'unknown')
const attachment = object({ kind, name: nullable(text), state: oneOf('unresolved', 'missing') })
const parsedReplyFields = { originalId: nullable(text), idNamespace: nullable(text), text: nullable(text), senderName: nullable(text), sentAtMs: nullable(integer) }
const messageFields = { ordinal: count, senderKind, senderName: text, sentAtMs: nullable(integer), timeRaw: nullable(text), timePrecision: precision, timezone: nullable(text), kind, text, sourceType: nullable(text), attachments: array(attachment) }
const message = object({ ...messageFields, id: localId, conversationId: localId, memberId: nullable(localId), isSelf: bool, timeBucket: oneOf(0, 1), sortTime: integer, reply: nullable(object({ ...parsedReplyFields, targetMessageId: nullable(localId), state: oneOf('unresolved', 'resolved') })) })
const position = object({ id: localId, timeBucket: oneOf(0, 1), sortTime: integer })
const messagePage = object({ items: array(message, 200), beforeCursor: nullable(cursor), afterCursor: nullable(cursor), snapshotMaxId: zeroId })
const sourceWindow: Check = value => object({ status: oneOf('unavailable') })(value) || object({ status: oneOf('available'), conversationId: localId, startMessageId: localId, endMessageId: localId, start: position, end: position, page: messagePage, rangeEndCursor: cursor })(value)
const counts = object({ seen: count, validRecords: count, invalidRecords: count })
const issue = object({ code: key, severity: oneOf('warning', 'blocking'), candidateId: text, ordinal: optional(count), action: text })
const member = object({ sourceKey: text, displayName: text, stableAccountKey: nullable(text), selfHint: nullable(bool) })
const discovery = object({ entries: array(object({ entryId: key, displayName: text, formatId: text }), 10000), unrecognized: array(object({ displayName: text }), 10000), issues: array(issue) })
const candidate = object({ candidateId: key, entryId: key, title: text, formatId: text, parserVersion: text, sourceKey: text, kind: chatKind, identity: object({ platform: text, ownerKey: nullable(text), conversationKey: nullable(text), namespace: text }), members: array(member), fingerprint: nullable(text), counts, status: oneOf(...importResultStates), issues: array(issue) })
const snapshot = object({ jobId: localId, status: oneOf(...importJobStates), discovery: nullable(discovery), candidates: array(candidate), results: array(object({ candidateId: key, conversationId: nullable(localId), status: oneOf(...importResultStates), inserted: count, duplicates: count, committedAt: nullable(integer), issues: array(issue), summaryFailed: bool })), issues: array(issue), counts, inserted: count, duplicates: count })
export const sourceHandle = object({ token: key, displayName: text, kind: oneOf('file', 'directory') })
const alias = object({ platform: text, aliasKey: text, accountKey: text })
const target: Check = value => object({ kind: oneOf('new') })(value) || object({ kind: oneOf('existing'), conversationId: localId })(value)
const start: Check = value => object({ kind: oneOf('stage'), jobId: localId, entryIds: array(key, 10000) })(value) || object({ kind: oneOf('commit'), plan: object({ jobId: localId, decisions: array(object({ candidateId: key, target, confirmedAliases: array(alias, 10000), selfMemberKey: optional(nullable(text)) }), 10000) }) })(value)
const listInput = object({ cursor: optional(cursor), limit: optional(limit(200)) })
const readInput = object({ conversationId: localId, cursor: optional(cursor), direction: oneOf('before', 'after'), limit: optional(limit(200)) })
const locateInput = object({ conversationId: localId, messageId: localId, endMessageId: optional(localId) })
const previewOptions = object({ afterOrdinal: optional(value => integer(value) && (value as number) >= -1), limit: optional(limit(50)) })
const argumentsByMethod: Record<DesktopMethod, Check[]> = {
  chooseSources: [oneOf('files', 'directory')], prepareImport: [array(sourceHandle, 10000)], startImport: [start], getImport: [localId], cancelImport: [localId],
  previewImport: [localId, key, previewOptions], listConversations: [listInput], readMessages: [readInput], locateSource: [locateInput], listMembers: [localId], confirmSelf: [localId, nullable(localId)], retrySummary: [localId],
}
const nothing: Check = value => value === undefined
const resultsByMethod: Record<DesktopMethod, Check> = {
  chooseSources: array(sourceHandle, 10000), prepareImport: localId, startImport: localId, getImport: snapshot, cancelImport: nothing,
  previewImport: object({ messages: array(object({ ...messageFields, senderKey: nullable(text), reply: nullable(object(parsedReplyFields)) }), 50), nextOrdinal: nullable(count) }),
  listConversations: object({ items: array(object({ id: localId, title: text, kind: chatKind, messageCount: count, memberCount: count, firstSentAtMs: nullable(integer), lastSentAtMs: nullable(integer), summaryStatus: oneOf('pending', 'ready', 'failed') }), 200), nextCursor: nullable(cursor) }),
  readMessages: messagePage, locateSource: sourceWindow, listMembers: array(object({ id: localId, displayName: text, selfHint: nullable(bool), confirmedSelf: bool })), confirmSelf: nothing, retrySummary: nothing,
}
export class BoundaryError extends Error {
  readonly action: string
  constructor(readonly code: string, action = '请检查输入后重试。') { super(action); this.action = action }
}
export function validateArguments(method: unknown, args: unknown): asserts method is DesktopMethod {
  if (typeof method !== 'string' || !Object.hasOwn(argumentsByMethod, method)) throw new BoundaryError('INVALID_METHOD', '请选择可用操作。')
  const checks = argumentsByMethod[method as DesktopMethod]
  if (!Array.isArray(args) || args.length !== checks.length || !checks.every((check, index) => check(args[index]))) throw new BoundaryError('INVALID_ARGUMENT')
}
export function validateResult(method: DesktopMethod, value: unknown): void {
  if (!resultsByMethod[method](value)) throw new BoundaryError('INVALID_RESPONSE', '请重新打开应用后重试。')
}
export function validateSnapshot(value: unknown): asserts value is ImportSnapshot {
  if (!snapshot(value)) throw new BoundaryError('INVALID_RESPONSE', '请重新打开应用后重试。')
}
export function validateError(value: unknown): asserts value is DesktopError {
  if (!object({ code: key, action: text })(value)) throw new BoundaryError('INVALID_RESPONSE', '请重新打开应用后重试。')
}
