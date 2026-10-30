import type { AiEvent, AiMethods } from './ai-contract'
import { BoundaryError, localId } from './desktop-validation'

type Check = (value: unknown) => boolean
const text = (max: number, nonempty = false): Check => value => typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0)
const key = text(128, true)
const bool: Check = value => typeof value === 'boolean'
const count: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const positive: Check = value => count(value) && (value as number) > 0
const metric: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const optional = (check: Check): Check => value => value === undefined || check(value)
const array = (check: Check, max = 10000): Check => value => Array.isArray(value) && value.length <= max && value.every(check)
const ids: Check = value => array(localId, 2000)(value) && new Set(value as string[]).size === (value as string[]).length
const object = (fields: Record<string, Check>): Check => value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, check]) => check((value as Record<string, unknown>)[key]))
const url: Check = value => { try { if (typeof value !== 'string' || value.length > 2048) return false; const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash && !parsed.search } catch { return false } }
const modelFields = { id: key, label: text(256, true), model: key, baseUrl: url, contextWindow: positive, maxTokens: positive, enabled: bool }
const model = object({ ...modelFields, version: positive, hasCredential: bool })
const usage = object({ inputTokens: optional(count), outputTokens: optional(count), cacheReadTokens: optional(count), cacheWriteTokens: optional(count), outputTokensPerSecond: optional(metric), firstTokenMs: optional(metric), durationMs: optional(metric), incomplete: optional(bool) })
const state: Check = value => ['queued', 'running', 'summarizing', 'completed', 'stopped', 'failed', 'interrupted'].includes(value as string)
const report = object({ summary: text(100000, true), observations: array(object({ text: text(20000, true), evidenceMessageIds: ids, limitations: text(20000) }), 200), limitations: text(20000) })
const analysis = object({ id: localId, conversationId: localId, modelId: key, state, analyzedMessages: count, totalMessages: count, skippedMessages: count, usage, error: optional(text(2000)), report: optional(report), valid: bool, eventSequence: count })
const turn = object({ id: localId, threadId: localId, requestId: key, prompt: text(100000, true), referenceIds: ids, modelId: key, skillId: optional(key), text: text(2 * 1024 ** 2), state, attempt: positive, usage, error: optional(text(2000)), eventSequence: count })
const thread = object({ id: localId, conversationId: localId, turns: array(turn, 10000) })
const preparation = object({ token: key, conversationId: localId, title: text(2000), selfName: text(2000), totalMessages: count, analyzableMessages: count, snapshotMaxId: localId, expiresAt: count, model })
const input: Record<keyof AiMethods, Check[]> = {
  listModels: [], saveModel: [object({ ...modelFields, apiKey: optional(text(16384)) })], testModel: [key], listSkills: [],
  prepareAnalysis: [object({ conversationId: localId, modelId: key })], confirmAnalysis: [object({ token: key, requestId: key })],
  getAnalysis: [localId], listAnalyses: [optional(localId)], stopAnalysis: [localId], continueAnalysis: [localId], getReport: [localId],
  openThread: [localId], getThread: [localId], sendTurn: [object({ threadId: localId, requestId: key, prompt: text(100000, true), referenceIds: ids, modelId: key, skillId: optional(key) })], retryTurn: [localId], stopTurn: [localId],
}
const output: Record<keyof AiMethods, Check> = {
  listModels: array(model, 1000), saveModel: model, testModel: value => value === undefined, listSkills: array(object({ id: key, label: text(256, true), version: key }), 1000),
  prepareAnalysis: preparation, confirmAnalysis: analysis, getAnalysis: analysis, listAnalyses: array(analysis), stopAnalysis: analysis, continueAnalysis: analysis, getReport: report,
  openThread: thread, getThread: thread, sendTurn: turn, retryTurn: turn, stopTurn: turn,
}
export function validateAiCall(method: unknown, args: unknown): asserts method is keyof AiMethods {
  if (typeof method !== 'string' || !Object.hasOwn(input, method)) throw new BoundaryError('INVALID_METHOD')
  if (method === 'listAnalyses' && Array.isArray(args) && args.length === 0) return
  const checks = input[method as keyof AiMethods]
  if (!Array.isArray(args) || args.length !== checks.length || !checks.every((check, index) => check(args[index]))) throw new BoundaryError('INVALID_ARGUMENT')
  if (method === 'saveModel') { const value = args[0]; if (value.contextWindow > 2000000 || value.maxTokens > value.contextWindow || value.maxTokens < 32) throw new BoundaryError('INVALID_ARGUMENT') }
}
export function validateAiResult(method: keyof AiMethods, value: unknown): void {
  if (!output[method](value)) throw new BoundaryError('INVALID_RESPONSE', '请重新打开应用后重试。')
}
export function validateAiEvent(value: unknown): asserts value is AiEvent {
  if (!object({ kind: value => value === 'analysis', snapshot: analysis })(value) && !object({ kind: value => value === 'turn', snapshot: turn })(value)) throw new BoundaryError('INVALID_RESPONSE')
}
