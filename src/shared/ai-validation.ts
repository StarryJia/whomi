import { isSubscriptionId } from './chatgpt-plan'
import type { AiEvent, AiMethods } from './ai-contract'
import { BoundaryError, availableSourceWindowFields, listArrangement, localId } from './desktop-validation'
import { insightTitle, isInsightScope, isInsightTimezone, type InsightCitationWindow } from './conversation-insights'
import { isModelProtocol } from './model-protocol'

type Check = (value: unknown) => boolean
const text = (max: number, nonempty = false): Check => value => typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0)
const key = text(128, true)
const bool: Check = value => typeof value === 'boolean'
const thinking: Check = value => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value as string)
const count: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestamp: Check = value => typeof value === 'number' && Number.isSafeInteger(value)
const positive: Check = value => count(value) && (value as number) > 0
const metric: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const optional = (check: Check): Check => value => value === undefined || check(value)
const nullable = (check: Check): Check => value => value === null || check(value)
const array = (check: Check, max = 10000): Check => value => Array.isArray(value) && value.length <= max && value.every(check)
const ids: Check = value => array(localId, 2000)(value) && new Set(value as string[]).size === (value as string[]).length
const object = (fields: Record<string, Check>): Check => value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, check]) => check((value as Record<string, unknown>)[key]))
const url: Check = value => { try { if (typeof value !== 'string' || value.length > 2048) return false; const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash && !parsed.search } catch { return false } }
const modelFields = { id: key, label: text(256, true), model: key, baseUrl: url, protocol: optional(isModelProtocol), contextWindow: nullable(positive), maxTokens: nullable(positive), maxInputTokens: optional(nullable(positive)), thinkingLevels: optional(array(thinking, 7)), enabled: bool }
const model = object({ ...modelFields, planProvider: optional(isSubscriptionId), planAccount: optional(text(512, true)), version: positive, hasCredential: bool })
const usageFields = { inputTokens: optional(count), totalInputTokens: optional(count), outputTokens: optional(count), cacheReadTokens: optional(count), cacheWriteTokens: optional(count), outputTokensPerSecond: optional(metric), firstTokenMs: optional(metric), durationMs: optional(metric), startedAt: optional(count), completedAt: optional(count), incomplete: optional(bool) }
const usage = object(usageFields)
const analysisUsage = object({ ...usageFields, cacheReadTokensIncomplete: optional(bool), cacheWriteTokensIncomplete: optional(bool) })
const state: Check = value => ['queued', 'running', 'summarizing', 'completed', 'stopped', 'failed', 'interrupted'].includes(value as string)
const legacyReport = object({ summary: text(100000, true), observations: array(object({ text: text(20000, true), evidenceMessageIds: ids, limitations: text(20000) }), 200), limitations: text(20000) })
const direction = (pair: string): Check => nullable(value => typeof value === 'string' && value.length === 1 && pair.includes(value))
const memoryFields = { dimensions: object({ EI: direction('EI'), SN: direction('SN'), TF: direction('TF'), JP: direction('JP') }), events: array(object({ title: text(256, true), text: text(20000, true) }), 200), relationship: text(20000, true) }
const memoryReport = object({ ...memoryFields, format: value => value === 'memory-v2' })
const votePair: Check = value => Array.isArray(value) && value.length === 2 && value.every(count)
const scoredReport = object({ ...memoryFields, format: value => value === 'memory-v3', eventVotes: object({ EI: votePair, SN: votePair, TF: votePair, JP: votePair }) })
const explanation = nullable(object({ text: text(4000, true), evidenceMessageIds: ids }))
const explainedReport = object({ ...memoryFields, format: value => value === 'memory-v4', eventVotes: object({ EI: votePair, SN: votePair, TF: votePair, JP: votePair }),
  dimensionExplanations: object({ EI: explanation, SN: explanation, TF: explanation, JP: explanation }) })
const revision: Check = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const sourceRef = object({ messageId: localId, revision })
const sourceRefs: Check = value => array(sourceRef, 2000)(value) && new Set((value as { messageId: string }[]).map(source => source.messageId)).size === (value as unknown[]).length
const fragment = object({ sources: value => sourceRefs(value) && (value as unknown[]).length > 0 })
const citation = object({ id: key, conversationId: localId, fragments: value => array(fragment, 200)(value) && (value as unknown[]).length > 0 })
const paragraphs = array(object({ content: array(object({ text: text(20000, true), citationId: optional(key) }), 200) }), 200)
const notes = array(text(4000, true), 200)
const judgmentFields = { text: text(4000, true), supportingSources: value => sourceRefs(value) && (value as unknown[]).length > 0, counterexampleSources: sourceRefs, alternativeExplanations: notes, limitations: notes } satisfies Record<string, Check>
const judgments = array(value => ['EI', 'SN', 'TF', 'JP'].some(dimension => object({ dimension: name => name === dimension, direction: direction(dimension), ...judgmentFields })(value)), 200)
const insightReport = object({ format: value => value === 'conversation-insights-v1', aboutYou: paragraphs, relationship: paragraphs, citations: array(citation, 2000), limitations: notes, judgments: optional(judgments) })
const report: Check = value => legacyReport(value) || memoryReport(value) || scoredReport(value) || explainedReport(value) || insightReport(value)
const modelIdentity = object({ id: key, version: positive, label: text(256, true), model: key })
const analysis = object({ id: localId, conversationId: localId, conversationTitle: optional(text(100000)), counterpartName: optional(text(100000)), title: optional(value => typeof value === 'string' && insightTitle(value) === value), scope: optional(isInsightScope), timezone: optional(isInsightTimezone), insightContentRevision: optional(revision), insightSelfFingerprint: optional(revision), elapsedMs: optional(count), elapsedSampledAtMs: optional(count), modelId: key, modelIdentity: optional(modelIdentity), createdAtMs: optional(nullable(count)), completedAtMs: optional(nullable(count)), sourceStartTimeMs: optional(nullable(timestamp)), sourceEndTimeMs: optional(nullable(timestamp)), pinned: optional(bool), thinkingLevel: optional(thinking), state, analyzedMessages: count, totalMessages: count, skippedMessages: count, usage: analysisUsage, error: optional(text(2000)), report: optional(report), valid: bool, eventSequence: count })
const turn = object({ id: localId, threadId: localId, requestId: key, prompt: text(100000, true), referenceIds: ids, modelId: key, modelIdentity: optional(modelIdentity), thinkingLevel: optional(thinking), skillId: optional(key), text: text(2 * 1024 ** 2), state, attempt: positive, usage, error: optional(text(2000)), eventSequence: count })
const threadFields = { pinned: optional(bool), id: localId, conversationId: localId, title: text(200, true), createdAtMs: count, updatedAtMs: count }
const thread = object({ ...threadFields, turns: array(turn, 10000) })
const preparation = object({ token: key, conversationId: localId, title: text(2000), selfName: text(2000), scope: optional(isInsightScope), timezone: optional(isInsightTimezone), totalMessages: count, analyzableMessages: count, snapshotMaxId: localId, expiresAt: count, thinkingLevel: optional(thinking), model })
const availableCitation = object({ ...availableSourceWindowFields, highlightIds: value => ids(value) && (value as unknown[]).length > 0 })
const citationWindow: Check = value => {
  if (object({ status: status => status === 'expired' || status === 'unavailable' })(value)) return true
  if (!availableCitation(value)) return false
  const window = value as Extract<InsightCitationWindow, { status: 'available' }>
  return window.startMessageId === window.start.id && window.endMessageId === window.end.id &&
    window.highlightIds[0] === window.startMessageId && window.highlightIds.at(-1) === window.endMessageId &&
    window.page.items.every(message => message.conversationId === window.conversationId)
}
const input: Record<keyof AiMethods, Check[]> = {
  listModels: [], saveModel: [object({ ...modelFields, apiKey: optional(text(16384)) })], testModel: [key], listSkills: [],
  previewInsightScope: [object({ conversationId: localId, scope: optional(isInsightScope) })],
  prepareAnalysis: [object({ conversationId: localId, modelId: key, thinkingLevel: optional(thinking), scope: optional(isInsightScope) })], confirmAnalysis: [object({ token: key, requestId: key })],
  discardAnalysisPreparation: [key],
  getAnalysis: [localId], listAnalyses: [optional(localId)], arrangeAnalysis: [listArrangement], renameAnalysis: [object({ taskId: localId, title: value => insightTitle(value) !== null })], deleteAnalysis: [localId], stopAnalysis: [localId], continueAnalysis: [localId], getReport: [localId],
  readInsightCitation: [object({ taskId: localId, citationId: key, fragmentIndex: count })],
  openThread: [localId], listThreads: [localId], createThread: [localId], getThread: [localId], arrangeThread: [localId, listArrangement], deleteThread: [localId, localId], sendTurn: [object({ threadId: localId, requestId: key, prompt: text(100000, true), referenceIds: ids, modelId: key, thinkingLevel: optional(thinking), skillId: optional(key) })], retryTurn: [localId], stopTurn: [localId],
}
const output: Record<keyof AiMethods, Check> = {
  listModels: array(model, 1000), saveModel: model, testModel: value => value === undefined, listSkills: array(object({ id: key, label: text(256, true), version: key }), 1000),
  previewInsightScope: object({ scope: isInsightScope, timezone: isInsightTimezone, totalMessages: count, analyzableMessages: count, sourceStartTimeMs: nullable(timestamp), sourceEndTimeMs: nullable(timestamp) }),
  prepareAnalysis: preparation, confirmAnalysis: analysis, getAnalysis: analysis, listAnalyses: array(analysis), arrangeAnalysis: value => value === undefined, renameAnalysis: analysis, deleteAnalysis: value => value === undefined, stopAnalysis: analysis, continueAnalysis: analysis, getReport: report, readInsightCitation: citationWindow,
  discardAnalysisPreparation: value => value === undefined,
  openThread: thread, listThreads: array(object(threadFields)), createThread: thread, getThread: thread, arrangeThread: value => value === undefined, deleteThread: value => value === undefined, sendTurn: turn, retryTurn: turn, stopTurn: turn,
}
export function validateAiCall(method: unknown, args: unknown): asserts method is keyof AiMethods {
  if (typeof method !== 'string' || !Object.hasOwn(input, method)) throw new BoundaryError('INVALID_METHOD')
  if (method === 'listAnalyses' && Array.isArray(args) && args.length === 0) return
  const checks = input[method as keyof AiMethods]
  if (!Array.isArray(args) || args.length !== checks.length || !checks.every((check, index) => check(args[index]))) throw new BoundaryError('INVALID_ARGUMENT')
  if (method === 'saveModel') {
    const value = args[0]
    if ((value.contextWindow !== null && (value.contextWindow < 256 || value.contextWindow > 2000000)) ||
      (value.maxTokens !== null && (value.maxTokens < 32 || value.maxTokens > 2000000 || (value.contextWindow !== null && value.maxTokens >= value.contextWindow))) ||
      (value.maxInputTokens != null && (value.maxInputTokens > 2000000 || (value.contextWindow !== null && value.maxInputTokens > value.contextWindow)))) throw new BoundaryError('INVALID_ARGUMENT')
  }
}
export function validateAiResult(method: keyof AiMethods, value: unknown): void {
  if (!output[method](value)) throw new BoundaryError('INVALID_RESPONSE', '请重新打开应用后重试。')
}
export function validateAiEvent(value: unknown): asserts value is AiEvent {
  if (!object({ kind: value => value === 'analysis', snapshot: analysis })(value) && !object({ kind: value => value === 'analysis-deleted', taskId: localId, conversationId: localId })(value) && !object({ kind: value => value === 'turn', snapshot: turn })(value)) throw new BoundaryError('INVALID_RESPONSE')
}
