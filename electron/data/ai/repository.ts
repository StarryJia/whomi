import { isOperationId } from '../../../src/shared/operation-diagnostics'
import { readPromptValues } from './system-prompts'
import { defaultProcessing, type ProcessingSettings } from '../../../src/shared/settings-contract'
import { validateProcessing } from '../settings/validation'
import { defaultPrompts, type PromptValues } from '../../../src/shared/system-prompts'
import { isThinkingLevel, type ThinkingLevel } from '../../../src/shared/thinking'
import { arrangeList, threadOrder } from '../db/list-order'
import { purgeAnalysis, purgeThread } from '../db/purge'
import { createQueries } from '../db/queries'
import type { ListArrangement } from '../../../src/shared/desktop-api'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import type { Store } from '../db/open'
import type { WriterQueue } from '../import/runner'
import { confirmedSelfSql } from '../db/self'
import { INSIGHT_PROMPT_VERSION } from './insight-prompts'
import { isInsightCitation, isInsightCitationId, validateAiCall, validateAiResult } from '../../../src/shared/ai-validation'
import { defaultInsightTitle, insightTitle, isInsightReport, isInsightScope, resolveReportCitation, type InsightCitation, type InsightCitationInput, type InsightCitationWindow, type InsightReport, type InsightScope, type InsightScopeInput, type InsightSnapshot, type InsightSourceRef } from '../../../src/shared/conversation-insights'
import { defaultModelProtocol, isModelProtocol } from '../../../src/shared/model-protocol'
import { BoundaryError, localId } from '../../../src/shared/desktop-validation'
import type { AiModel, AiSkill, AiState, AiThread, AiThreadSummary, AiTurn, AiUsage, AnalysisPreparation, AnalysisTask, AnalysisUsage, PrepareAnalysisInput } from '../../../src/shared/ai-contract'
import { threadTitle } from './thread-title'
import { prepareTurnProfile } from './turn-profile'
import { captureInsightSources, populateReportExcerpts, previewInsightScope, readCurrentInsightSources, readInsightCitationIds, readInsightSources, type StoredInsightSnapshot, type StoredInsightSourceRef } from './insight-sources'

export type AiSourceMessage = { id: string; senderName: string; text: string; isSelf: boolean; kind: string; sentAtMs: number | null; memberId: string | null }
export type AnalysisContext = { processing?: ProcessingSettings; systemPrompts?: PromptValues; task: AnalysisTask; model: AiModel; checkpoint: string | null; snapshot: InsightSnapshot }
export type RegisteredSkill = AiSkill & { content: string; enabled?: boolean }
type TurnReferences = { references: AiSourceMessage[]; referenceBreaks?: string[] }
export type TurnContext = TurnReferences & { systemPrompt?: string; turn: AiTurn; threadId: string; conversationId: string; model: AiModel; selfFingerprint: string; history: ({ role: 'user' | 'assistant'; text: string } & Partial<TurnReferences>)[]; profile: InsightReport | null; skill: RegisteredSkill | null; checkpoint: string | null }
type StatePatch = { state?: AiState; error?: string }
export type AnalysisPatch = StatePatch & Pick<AnalysisTask, 'failureOperationId' | 'failureAtMs'>
export type TurnPatch = StatePatch & { text?: string; usage?: AiUsage; checkpoint?: string | null }
export type NewTurn = { thinkingLevel?: ThinkingLevel; threadId: string; requestId: string; prompt: string; referenceIds: string[]; modelId: string; skillId?: string }
export type ModelInput = Omit<AiModel, 'version' | 'hasCredential'>
export type UsageRecord = { ownerKind: 'analysis' | 'turn'; ownerId: string; requestId: string; usage: AiUsage }
type AnalysisRow = { failure_operation_id: string | null; failure_at_ms: bigint | null; title: string | null; elapsed_ms: bigint; prompt_snapshot: string | null; thinking_level: ThinkingLevel | null; id: bigint; conversation_id: bigint; model_id: string; model_version: bigint; created_at_ms: bigint | null; completed_at_ms: bigint | null; pinned: bigint; prompt_version: string; self_fingerprint: string; snapshot_max_id: bigint; state: AiState; total_messages: bigint; skipped_messages: bigint; event_sequence: bigint; error: string | null; checkpoint: string | null }
type InsightSnapshotRow = { scope: string; timezone: string; source_start_time_ms: bigint | null; source_end_time_ms: bigint | null; source_text_bytes: bigint | null; created_at_ms: bigint; sources: string }
type ReportRow = { data: string; content_revision: string | null }
function readInsightReport(data: string, conversationId: bigint): InsightReport {
  const report = parse<InsightReport>(data)
  if (!isInsightReport(report)) fail('INVALID_REPORT', '请重新生成这份报告。')
  const citations = new Map<string, InsightCitation>()
  const seen = new Set<string>()
  for (const entry of Array.isArray(report.citations) ? report.citations : []) {
    if (typeof entry?.id !== 'string') continue
    if (seen.has(entry.id)) {
      // 同一编号对应多条记录时，无法确定正文引用了哪一条。
      citations.delete(entry.id)
      continue
    }
    seen.add(entry.id)
    if (entry.conversationId === String(conversationId) && isInsightCitation(entry)) citations.set(entry.id, entry)
  }
  // 未匹配的编号让正文保留无法定位提示，同时避免链接到另一处有效引用。
  let unavailableId = 'unavailable'
  for (let suffix = 1; citations.has(unavailableId); suffix++) unavailableId = `unavailable-${suffix}`
  for (const section of [report.aboutYou, report.relationship]) {
    if (!Array.isArray(section)) continue
    for (const paragraph of section) {
      if (!Array.isArray(paragraph?.content)) continue
      for (const part of paragraph.content) {
        delete part?.quoteFragmentIndex
        delete part?.quoteMessageId
        if (part?.citationId !== undefined && !isInsightCitationId(part.citationId)) part.citationId = unavailableId
      }
    }
  }
  return { ...report, citations: [...citations.values()] }
}
type TurnRow = { system_prompt: string | null; thinking_level: ThinkingLevel | null; id: bigint; thread_id: bigint; request_id: string; prompt: string; reference_ids: string; model_id: string; model_version: bigint; skill: string | null; self_fingerprint: string; text: string; state: AiState; attempt: bigint; event_sequence: bigint; error: string | null; checkpoint: string | null }
type ThreadRow = { pinned: bigint; id: bigint; conversation_id: bigint; title: string; created_at_ms: bigint; updated_at_ms: bigint }
function threadView(row: ThreadRow): AiThreadSummary { return { pinned: !!row.pinned, id: String(row.id), conversationId: String(row.conversation_id), title: row.title, createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) } }
const activeStates = new Set<AiState>(['queued', 'running'])
const states = new Set<AiState>([...activeStates, 'completed', 'stopped', 'failed', 'interrupted'])
const tokenFields = ['inputTokens', 'totalInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
const usageFields = [...tokenFields, 'durationMs', 'firstTokenMs', 'outputTokensPerSecond', 'startedAt', 'completedAt'] as const
function fail(code: string, action = '请检查输入后重试。'): never { throw new BoundaryError(code, action) }
function id(value: unknown): bigint { if (!localId(value)) fail('INVALID_ID'); return BigInt(value as string) }
function text(value: unknown, max = 1024 * 1024): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function key(value: unknown): value is string { return text(value, 256) }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> { if (!object(value) || Object.keys(value).some(field => !allowed.includes(field))) fail('INVALID_ARGUMENT') }
function parse<T>(value: string): T { return JSON.parse(value) as T }
function insightElapsedAt(row: AnalysisRow, now: number, sampledAtMs?: number) {
  if (sampledAtMs === undefined) return row.elapsed_ms
  if (row.prompt_version !== INSIGHT_PROMPT_VERSION || !Number.isSafeInteger(sampledAtMs) || sampledAtMs < 0) fail('INVALID_INSIGHT_CHECKPOINT')
  return row.elapsed_ms + BigInt(Math.max(0, now - sampledAtMs))
}
function optionalNumber(value: bigint | null): number | null { return value === null ? null : Number(value) }
function usage(value: AiUsage): AiUsage {
  fields(value, [...usageFields, 'incomplete'])
  for (const field of usageFields) if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field]! < 0)) fail('INVALID_USAGE')
  for (const field of tokenFields) if (value[field] !== undefined && !Number.isSafeInteger(value[field])) fail('INVALID_USAGE')
  if (value.incomplete !== undefined && typeof value.incomplete !== 'boolean') fail('INVALID_USAGE')
  return value
}
export function saveAiModelVersion(db: Store['writer'], input: ModelInput, encryptedKey?: string | null, source: 'settings' | 'catalog' | 'account' = 'settings'): AiModel {
  const previous = db.prepare('SELECT version,encrypted_key FROM ai_models WHERE id=?').get(input.id) as { version: bigint; encrypted_key: string | null } | undefined
  const secret = encryptedKey === undefined ? previous?.encrypted_key ?? null : encryptedKey
  const model: AiModel = { ...(input.thinkingLevels ? { thinkingLevels: input.thinkingLevels } : {}), ...(input.planAccount ? { planAccount: input.planAccount, planProvider: input.planProvider } : {}), id: input.id, label: input.label, model: input.model, baseUrl: input.baseUrl, protocol: input.protocol ?? defaultModelProtocol, contextWindow: input.contextWindow, maxTokens: input.maxTokens, ...(input.maxInputTokens !== undefined ? { maxInputTokens: input.maxInputTokens } : {}), enabled: input.enabled, version: Number(previous?.version ?? 0n) + 1, hasCredential: secret !== null }
  db.prepare('INSERT INTO ai_models(id,version,data,encrypted_key) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data,encrypted_key=excluded.encrypted_key').run(model.id, model.version, JSON.stringify(model), secret)
  db.prepare('INSERT INTO ai_model_versions(model_id,version,data,encrypted_key,change_source) VALUES(?,?,?,?,?)').run(model.id, model.version, JSON.stringify(model), secret, source)
  return model
}

export function createAiRepository(store: Store, write: WriterQueue) {
  const db = store.writer, reader = store.reader
  function discardExpiredPreparations(now: number) {
    db.prepare(`DELETE FROM ai_preparations WHERE expires_at_ms<=?
      AND NOT EXISTS (SELECT 1 FROM ai_analysis_tasks WHERE preparation_token=ai_preparations.token)`).run(now)
  }
  const queries = createQueries(store)
  function conversation(conversationId: string) {
    const row = reader.prepare('SELECT title,kind FROM conversations WHERE id=?').get(id(conversationId)) as { title: string; kind: string } | undefined
    if (!row) fail('INVALID_ID', '请刷新会话列表后重试。')
    return row
  }
  function identity(conversationId: string) {
    const { title, kind } = conversation(conversationId)
    const confirmation = reader.prepare(`SELECT s.id,s.member_id,m.display_name FROM self_confirmations s JOIN memberships m ON m.id=s.member_id AND m.conversation_id=s.conversation_id WHERE s.conversation_id=? AND s.status='confirmed' AND s.source='user' AND NOT EXISTS(SELECT 1 FROM self_opt_outs o WHERE o.conversation_id=s.conversation_id)`).get(id(conversationId)) as { id: bigint; member_id: bigint; display_name: string } | undefined
    const members = reader.prepare(`SELECT m.id,m.account_id FROM memberships m WHERE m.conversation_id=? AND ${confirmedSelfSql} ORDER BY m.id`).all(id(conversationId)) as { id: bigint; account_id: bigint | null }[]
    const fingerprint = createHash('sha256').update(JSON.stringify({ confirmation: confirmation ? String(confirmation.id) : null, members: members.map(member => [String(member.id), member.account_id === null ? null : String(member.account_id)]) })).digest('hex')
    return { fingerprint, selfName: confirmation?.display_name ?? null, title, kind }
  }
  function modelSecret(modelId: string, version?: number): { model: AiModel; encryptedKey: string | null } {
    if (!key(modelId) || (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) fail('INVALID_MODEL')
    const row = (version === undefined ? reader.prepare('SELECT data,encrypted_key FROM ai_models WHERE id=?').get(modelId) : reader.prepare('SELECT data,encrypted_key FROM ai_model_versions WHERE model_id=? AND version=?').get(modelId, version)) as { data: string; encrypted_key: string | null } | undefined
    if (!row) fail('INVALID_MODEL', '请配置可用模型。')
    return { model: { protocol: defaultModelProtocol, ...parse<AiModel>(row.data) }, encryptedKey: row.encrypted_key }
  }
  function enabledModel(modelId: string): AiModel { const model = modelSecret(modelId).model; if (!model.enabled) fail('INVALID_MODEL', '请选择可用模型。'); return model }
  function sameModelConfiguration(id: string, version: number) {
    const current = enabledModel(id)
    if (current.version === version) return true
    const original = modelSecret(id, version).model
    // 自动补全容量、原套餐重新登录后，旧任务仍使用冻结版本。
    const manualChange = reader.prepare("SELECT 1 FROM ai_model_versions WHERE model_id=? AND version>? AND change_source='settings' LIMIT 1").get(id, version)
    if (!manualChange) return current.planAccount === original.planAccount
    if (!current.planAccount) return false
    // 同一套餐账号重新授权只改变可用状态；任务仍使用保存时的完整配置。
    const { thinkingLevels: _snapshotLevels, ...snapshotConfig } = original
    const { thinkingLevels: _currentLevels, ...currentConfig } = current
    return isDeepStrictEqual({ ...snapshotConfig, version: current.version, enabled: current.enabled }, currentConfig)
  }
  function analysisRow(taskId: string) {
    const row = reader.prepare('SELECT * FROM ai_analysis_tasks WHERE id=?').get(id(taskId)) as (AnalysisRow & { processing_snapshot: string | null }) | undefined
    if (!row) fail('INVALID_TASK', '请刷新分析任务后重试。')
    return row
  }
  function insightSnapshot(row: AnalysisRow): StoredInsightSnapshot {
    const saved = reader.prepare('SELECT * FROM ai_insight_snapshots WHERE task_id=?').get(row.id) as InsightSnapshotRow | undefined
    if (!saved || row.prompt_version !== INSIGHT_PROMPT_VERSION) fail('INSIGHT_SNAPSHOT_UNAVAILABLE', '请重新准备分析。')
    return {
      taskId: String(row.id), scope: parse<InsightScope>(saved.scope), timezone: saved.timezone, createdAtMs: Number(saved.created_at_ms),
      sourceStartTimeMs: optionalNumber(saved.source_start_time_ms), sourceEndTimeMs: optionalNumber(saved.source_end_time_ms),
      ...(saved.source_text_bytes === null ? {} : { sourceTextBytes: Number(saved.source_text_bytes) }),
      sources: parse<StoredInsightSourceRef[]>(saved.sources),
    }
  }
  function checkedInsightSources(row: AnalysisRow, snapshot: InsightSnapshot, messageIds: readonly string[]) {
    return readInsightSources(snapshot, messageIds, readCurrentInsightSources(reader, row.conversation_id, messageIds))
  }
  function validateInsightReport(row: AnalysisRow, report: InsightReport, current: ReturnType<typeof checkedInsightSources>) {
    const sources = new Map(current.map(message => [message.id, message]))
    const validRef = (source: InsightSourceRef) => sources.get(source.messageId)?.revision === source.revision
    const citationIds = new Set<string>()
    for (const citation of report.citations) {
      if (citationIds.has(citation.id) || citation.conversationId !== String(row.conversation_id) ||
        citation.fragments.some(fragment => fragment.sources.some(source => !validRef(source)))) {
        fail('INVALID_INSIGHT_CITATION', '请重新生成这份报告。')
      }
      citationIds.add(citation.id)
    }
    for (const paragraph of [...report.aboutYou, ...report.relationship]) {
      if (paragraph.content.some(part => part.citationId && !citationIds.has(part.citationId))) {
        fail('INVALID_INSIGHT_CITATION', '请重新生成这份报告。')
      }
    }
    for (const judgment of report.judgments ?? []) {
      if (((judgment.direction !== null || judgment.supportingSources.length > 0) &&
          !judgment.supportingSources.some(source => sources.get(source.messageId)?.isSelf)) ||
        [...judgment.supportingSources, ...judgment.counterexampleSources].some(source =>
          !validRef(source) || source.excerpts?.some(phrase => !sources.get(source.messageId)?.text.includes(phrase)))) {
        fail('INVALID_INSIGHT_JUDGMENT', '请重新生成这份报告。')
      }
    }
  }
  function turnRow(turnId: string): TurnRow {
    const row = reader.prepare('SELECT * FROM ai_turns WHERE id=?').get(id(turnId)) as TurnRow | undefined
    if (!row) fail('INVALID_TURN', '请重新打开对话。')
    return row
  }
  function threadConversation(threadId: string): string {
    const row = reader.prepare('SELECT conversation_id FROM ai_threads WHERE id=?').get(id(threadId)) as { conversation_id: bigint } | undefined
    if (!row) fail('INVALID_THREAD', '请重新打开对话。')
    return String(row.conversation_id)
  }
  function sources(conversationId: string, messageIds: string[]): TurnReferences {
    if (!Array.isArray(messageIds) || messageIds.length > 10000 || messageIds.some(message => !localId(message)) || new Set(messageIds).size !== messageIds.length) fail('INVALID_REFERENCE')
    const references: AiSourceMessage[] = [], referenceBreaks: string[] = []
    const fetch = reader.prepare(`SELECT x.id,x.sender_name,x.text,x.kind,x.sent_at_ms,x.member_id,
      coalesce((SELECT ${confirmedSelfSql} FROM memberships m WHERE m.id=x.member_id AND m.conversation_id=x.conversation_id),0) AS is_self,
      CASE WHEN x.sent_at_ms IS NOT NULL THEN coalesce(
        (SELECT p.id FROM messages p WHERE p.conversation_id=x.conversation_id AND p.time_bucket=0
          AND p.sort_time=x.sort_time AND p.id<x.id ORDER BY p.id DESC LIMIT 1),
        (SELECT p.id FROM messages p WHERE p.conversation_id=x.conversation_id AND p.time_bucket=0
          AND p.sort_time<x.sort_time ORDER BY p.sort_time DESC,p.id DESC LIMIT 1)
      ) END AS preceding_id
      FROM messages x WHERE x.conversation_id=? AND x.id=?`)
    for (const messageId of messageIds) {
      const row = fetch.get(id(conversationId), id(messageId)) as { id: bigint; sender_name: string; text: string; kind: string; sent_at_ms: bigint | null; member_id: bigint | null; is_self: bigint; preceding_id: bigint | null } | undefined
      if (!row) fail('INVALID_REFERENCE', '请选择当前会话中的消息。')
      // 用户可以跳选或逆序引用，只有在原聊天中相邻的引用才能合并。
      if (references.length && references.at(-1)!.id !== row.preceding_id?.toString()) referenceBreaks.push(messageId)
      references.push({ id: String(row.id), senderName: row.sender_name, text: row.text, kind: row.kind, isSelf: row.is_self === 1n, sentAtMs: row.sent_at_ms === null ? null : Number(row.sent_at_ms), memberId: row.member_id === null ? null : String(row.member_id) })
    }
    return { references, referenceBreaks }
  }
  function aggregate(kind: 'analysis' | 'turn', ownerId: string): AnalysisUsage {
    const records = reader.prepare('SELECT data FROM ai_request_usage WHERE owner_kind=? AND owner_id=? ORDER BY request_id').all(kind, id(ownerId)) as { data: string }[]
    if (!records.length) return {}
    const values = records.map(row => parse<AiUsage>(row.data)), result: AnalysisUsage = {}
    if (kind === 'analysis') {
      for (const usage of values) {
        // 旧回执逐笔补上已知缓存，再与提供总量的新回执累计。
        if (usage.totalInputTokens === undefined && usage.inputTokens !== undefined) {
          usage.totalInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        }
      }
    }
    for (const field of [...tokenFields, 'durationMs'] as const) {
      const reported = values.filter(value => value[field] !== undefined)
      if (!reported.length) continue
      result[field] = reported.reduce((sum, value) => sum + value[field]!, 0)
      if (kind !== 'analysis' || reported.length === values.length) continue
      if (field === 'cacheReadTokens') result.cacheReadTokensIncomplete = true
      if (field === 'cacheWriteTokens') result.cacheWriteTokensIncomplete = true
    }
    if (values.some(value => value.incomplete || value.inputTokens === undefined || value.outputTokens === undefined)) result.incomplete = true
    if (result.outputTokens !== undefined && result.durationMs && result.durationMs > 0) result.outputTokensPerSecond = result.outputTokens / (result.durationMs / 1000)
    if (values.length === 1 && values[0].firstTokenMs !== undefined) result.firstTokenMs = values[0].firstTokenMs
    const starts = values.flatMap(value => value.startedAt === undefined ? [] : [value.startedAt])
    const ends = values.flatMap(value => value.completedAt === undefined ? [] : [value.completedAt])
    if (starts.length) result.startedAt = Math.min(...starts)
    if (ends.length) result.completedAt = Math.max(...ends)
    return result
  }
  function readCounterpartName(conversationId: bigint) {
    // 同名成员不一定是同一人；只有关联到同一账号的来源才能共用称呼。
    const candidates = reader.prepare(`SELECT DISTINCT m.account_id, CASE WHEN m.account_id IS NULL THEN m.id END,
      trim(m.display_name) AS name FROM memberships m
      WHERE m.conversation_id=? AND NOT (${confirmedSelfSql}) LIMIT 2`).all(conversationId) as { name: string }[]
    return candidates.length === 1 ? candidates[0].name.trim() || undefined : undefined
  }
  function taskView(row: AnalysisRow): AnalysisTask {
    const coverage = reader.prepare('SELECT count(*) AS n FROM ai_analysis_coverage WHERE task_id=?').get(row.id) as { n: bigint }
    const report = reader.prepare('SELECT data,content_revision FROM ai_reports WHERE task_id=?').get(row.id) as ReportRow | undefined
    const current = identity(String(row.conversation_id))
    const valid = row.self_fingerprint === current.fingerprint
    const counterpartName = row.state === 'completed' && valid && current.kind === 'direct' && current.selfName !== null
      ? readCounterpartName(row.conversation_id) : undefined
    const insight = reader.prepare('SELECT scope,timezone,source_start_time_ms AS start,source_end_time_ms AS end FROM ai_insight_snapshots WHERE task_id=?').get(row.id) as { scope: string; timezone: string; start: bigint | null; end: bigint | null } | undefined
    const snapshot = reader.prepare('SELECT data FROM ai_model_versions WHERE model_id=? AND version=?').get(row.model_id, row.model_version) as { data: string } | undefined
    let modelIdentity: AnalysisTask['modelIdentity']
    if (snapshot) {
      try {
        const model = parse<Partial<AiModel>>(snapshot.data)
        if (typeof model.label === 'string' && model.label.trim() && typeof model.model === 'string' && model.model.trim()) modelIdentity = { id: row.model_id, version: Number(row.model_version), label: model.label, model: model.model }
      } catch { /* 旧模型资料缺失时仍保留文稿。 */ }
    }
    return {
      ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
      id: String(row.id), conversationId: String(row.conversation_id), conversationTitle: current.title, ...(counterpartName && { counterpartName }),
      ...(row.title === null ? {} : { title: row.title }),
      ...(insight ? { scope: parse<InsightScope>(insight.scope), timezone: insight.timezone, insightSelfFingerprint: row.self_fingerprint, elapsedMs: Number(row.elapsed_ms) } : {}),
      ...(report?.content_revision ? { insightContentRevision: report.content_revision } : {}),
      modelId: row.model_id, ...(modelIdentity ? { modelIdentity } : {}),
      createdAtMs: optionalNumber(row.created_at_ms), completedAtMs: optionalNumber(row.completed_at_ms),
      sourceStartTimeMs: optionalNumber(insight?.start ?? null), sourceEndTimeMs: optionalNumber(insight?.end ?? null),
      pinned: !!row.pinned, state: row.state, analyzedMessages: Number(coverage.n), totalMessages: Number(row.total_messages),
      skippedMessages: Number(row.skipped_messages), usage: aggregate('analysis', String(row.id)), valid, eventSequence: Number(row.event_sequence),
      ...(isOperationId(row.failure_operation_id) && { failureOperationId: row.failure_operation_id }),
      ...(row.failure_at_ms != null && { failureAtMs: Number(row.failure_at_ms) }),
      ...(row.error ? { error: row.error } : {}), ...(report ? { report: readInsightReport(report.data, row.conversation_id) } : {}),
    }
  }
  function turnView(row: TurnRow): AiTurn {
    const skill = row.skill ? parse<RegisteredSkill>(row.skill) : null
    const snapshot = reader.prepare('SELECT data FROM ai_model_versions WHERE model_id=? AND version=?').get(row.model_id, row.model_version) as { data: string } | undefined
    let modelIdentity: AiTurn['modelIdentity']
    if (snapshot) {
      try {
        const model = parse<Partial<AiModel>>(snapshot.data)
        if (typeof model?.label === 'string' && model.label.trim() && typeof model.model === 'string' && model.model.trim()) {
          modelIdentity = { id: row.model_id, version: Number(row.model_version), label: model.label, model: model.model }
        }
      } catch { /* 缺失或损坏的旧模型身份不阻止读取已保存的正文。 */ }
    }
    return { ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}), id: String(row.id), threadId: String(row.thread_id), requestId: row.request_id, prompt: row.prompt, referenceIds: parse<string[]>(row.reference_ids), modelId: row.model_id, ...(modelIdentity ? { modelIdentity } : {}), ...(skill ? { skillId: skill.id } : {}), text: row.text, state: row.state, attempt: Number(row.attempt), usage: aggregate('turn', String(row.id)), eventSequence: Number(row.event_sequence), ...(row.error ? { error: row.error } : {}) }
  }
  function assertCurrent(row: AnalysisRow) {
    if (row.prompt_version !== INSIGHT_PROMPT_VERSION) fail('PROMPT_CHANGED', '请重新准备分析。')
    if (row.self_fingerprint !== identity(String(row.conversation_id)).fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新准备分析。')
  }
  function insertUsage(record: UsageRecord) {
    fields(record, ['ownerKind', 'ownerId', 'requestId', 'usage'])
    if (!['analysis', 'turn'].includes(record.ownerKind) || !key(record.requestId)) fail('INVALID_ARGUMENT')
    usage(record.usage)
    if (record.ownerKind === 'analysis') analysisRow(record.ownerId); else turnRow(record.ownerId)
    db.prepare('INSERT INTO ai_request_usage(owner_kind,owner_id,request_id,data) VALUES(?,?,?,?) ON CONFLICT(owner_kind,owner_id,request_id) DO UPDATE SET data=excluded.data').run(record.ownerKind, id(record.ownerId), record.requestId, JSON.stringify(record.usage))
  }
  function patchState(patch: TurnPatch, turn = false) {
    fields(patch, ['state', 'error', ...(turn ? ['text', 'usage', 'checkpoint'] : ['failureOperationId', 'failureAtMs'])])
    if (patch.state !== undefined && !states.has(patch.state)) fail('INVALID_STATE')
    if (patch.error !== undefined && (typeof patch.error !== 'string' || patch.error.length > 4096)) fail('INVALID_ARGUMENT')
    if (patch.checkpoint !== undefined && patch.checkpoint !== null && !text(patch.checkpoint, 32768)) fail('INVALID_ARGUMENT')
    if (patch.usage !== undefined) usage(patch.usage)
  }
  const repository = {
    listModels(): AiModel[] { return (reader.prepare('SELECT data FROM ai_models ORDER BY id').all() as { data: string }[]).map(row => ({ protocol: defaultModelProtocol, ...parse<AiModel>(row.data) })) },
    async saveModel(input: ModelInput, encryptedKey?: string | null): Promise<AiModel> {
      fields(input, ['id', 'label', 'model', 'baseUrl', 'protocol', 'contextWindow', 'maxTokens', 'maxInputTokens', 'enabled', 'version', 'hasCredential'])
      if (input.protocol !== undefined && !isModelProtocol(input.protocol)) fail('INVALID_MODEL')
      const validCapacity = (value: number | null | undefined, minimum = 1) => value === null || (Number.isSafeInteger(value) && value! >= minimum && value! <= 2000000)
      if (!key(input.id) || !text(input.label, 256) || !key(input.model) || !text(input.baseUrl, 4096) || !validCapacity(input.contextWindow, 256) || !validCapacity(input.maxTokens, 32) ||
        (input.contextWindow !== null && input.maxTokens !== null && input.maxTokens >= input.contextWindow) ||
        (input.maxInputTokens !== undefined && (!validCapacity(input.maxInputTokens) || (input.maxInputTokens !== null && input.contextWindow !== null && input.maxInputTokens > input.contextWindow))) ||
        typeof input.enabled !== 'boolean' || !(encryptedKey === undefined || encryptedKey === null || text(encryptedKey, 65536))) fail('INVALID_MODEL')
      try { const url = new URL(input.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('INVALID_MODEL') } catch { fail('INVALID_MODEL') }
      return write(() => db.transaction(() => {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings_models'").get()) fail('SETTINGS_REQUIRED', '请在设置中修改模型。')
        return saveAiModelVersion(db, input, encryptedKey)
      })())
    },
    modelSecret,
    listSkills(): AiSkill[] { return (reader.prepare('SELECT data FROM ai_skills ORDER BY id').all() as { data: string }[]).map(row => parse<RegisteredSkill>(row.data)).filter(skill => skill.enabled !== false).map(({ id: skillId, label, version }) => ({ id: skillId, label, version })) },
    async registerSkill(skill: RegisteredSkill) {
      fields(skill, ['id', 'label', 'version', 'content', 'enabled'])
      if (!key(skill.id) || !text(skill.label, 256) || !key(skill.version) || !text(skill.content) || (skill.enabled !== undefined && typeof skill.enabled !== 'boolean')) fail('INVALID_SKILL')
      return write(() => { db.prepare('INSERT INTO ai_skills(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(skill.id, JSON.stringify(skill)); return { id: skill.id, label: skill.label, version: skill.version } })
    },
    previewInsightScope(input: InsightScopeInput) {
      validateAiCall('previewInsightScope', [input])
      conversation(input.conversationId)
      return previewInsightScope(reader, id(input.conversationId), input.scope ?? { kind: 'all' })
    },
    async prepareAnalysis(input: PrepareAnalysisInput, now = Date.now()): Promise<AnalysisPreparation> {
      fields(input, ['conversationId', 'modelId', 'thinkingLevel', 'scope'])
      if (input.thinkingLevel !== undefined && !isThinkingLevel(input.thinkingLevel)) fail('INVALID_ARGUMENT')
      if (input.scope !== undefined && !isInsightScope(input.scope)) fail('INVALID_ARGUMENT', '请选择有效的日期范围。')
      return write(() => {
        discardExpiredPreparations(now)
        const { title } = conversation(input.conversationId), self = identity(input.conversationId)
        if (!self.selfName) fail('SELF_REQUIRED', '请先确认当前会话中的本人身份。')
        const model = enabledModel(input.modelId)
        const { totalMessages, analyzableMessages, conversationMessages, snapshotMaxId, ...snapshot } = captureInsightSources(reader, id(input.conversationId), input.scope ?? { kind: 'all' })
        if (!conversationMessages) fail('EMPTY_CONVERSATION', '请先导入聊天记录。')
        if (snapshot.scope.kind === 'dates' && !analyzableMessages) fail('EMPTY_INSIGHT_SCOPE', '请选择有聊天文字的日期范围。')
        if (!analyzableMessages) fail('NO_ANALYZABLE_MESSAGES', '请导入包含文字的聊天记录。')
        const preparation: AnalysisPreparation = {
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}), token: randomUUID(), conversationId: input.conversationId,
          title, selfName: self.selfName, scope: snapshot.scope, timezone: snapshot.timezone, totalMessages,
          analyzableMessages, snapshotMaxId, expiresAt: now + 5 * 60 * 1000, model,
        }
        db.prepare('INSERT INTO ai_preparations(token,conversation_id,data,self_fingerprint,model_version,prompt_version,expires_at_ms,insight_snapshot) VALUES(?,?,?,?,?,?,?,?)')
          .run(preparation.token, id(input.conversationId), JSON.stringify(preparation), self.fingerprint, model.version, INSIGHT_PROMPT_VERSION, preparation.expiresAt, JSON.stringify({ ...snapshot, createdAtMs: now }))
        return preparation
      })
    },
    async discardAnalysisPreparation(token: string): Promise<void> {
      if (!key(token)) fail('INVALID_ARGUMENT')
      await write(() => {
        // 迟到的取消不能删除已确认任务依赖的准备记录。
        db.prepare(`DELETE FROM ai_preparations WHERE token=?
          AND NOT EXISTS (SELECT 1 FROM ai_analysis_tasks WHERE preparation_token=ai_preparations.token)`).run(token)
      })
    },
    async confirmAnalysis(input: { token: string; requestId: string }, now = Date.now()): Promise<AnalysisTask> {
      fields(input, ['token', 'requestId']); if (!key(input.token) || !key(input.requestId)) fail('INVALID_ARGUMENT')
      const taskId = await write(() => db.transaction(() => {
        const existing = db.prepare('SELECT id,preparation_token FROM ai_analysis_tasks WHERE request_id=?').get(input.requestId) as { id: bigint; preparation_token: string } | undefined
        if (existing) { if (existing.preparation_token !== input.token) fail('REQUEST_CONFLICT'); return String(existing.id) }
        if (db.prepare('SELECT 1 FROM ai_analysis_tasks WHERE preparation_token=?').get(input.token)) fail('CONFIRMATION_USED', '请重新准备分析。')
        const row = db.prepare('SELECT data,self_fingerprint,prompt_version,expires_at_ms,insight_snapshot FROM ai_preparations WHERE token=?').get(input.token) as { data: string; self_fingerprint: string; prompt_version: string; expires_at_ms: bigint; insight_snapshot: string | null } | undefined
        if (!row || Number(row.expires_at_ms) <= now) fail('CONFIRMATION_EXPIRED', '请重新准备分析。')
        if (row.prompt_version !== INSIGHT_PROMPT_VERSION) fail('PROMPT_CHANGED', '请重新准备分析。')
        const preparation = parse<AnalysisPreparation>(row.data), self = identity(preparation.conversationId), model = enabledModel(preparation.model.id)
        if (self.fingerprint !== row.self_fingerprint || model.version !== preparation.model.version) fail('CONFIRMATION_CHANGED', '配置或本人身份已更新，请重新准备分析。')
        if (db.prepare("SELECT 1 FROM ai_analysis_tasks WHERE conversation_id=? AND state IN ('queued','running')").get(id(preparation.conversationId))) fail('ANALYSIS_BUSY', '请先完成或停止当前分析。')
        const snapshot = row.insight_snapshot ? parse<Omit<StoredInsightSnapshot, 'taskId'>>(row.insight_snapshot) : null
        if (!snapshot) fail('INSIGHT_SNAPSHOT_UNAVAILABLE', '请重新准备分析。')
        const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()
        const saved = hasSettings ? db.prepare("SELECT data FROM app_settings WHERE key='processing'").get() as { data: string } | undefined : undefined
        const processing = saved ? parse<ProcessingSettings>(saved.data) : defaultProcessing
        validateProcessing(processing)
        const taskId = db.prepare(`INSERT INTO ai_analysis_tasks(conversation_id,request_id,preparation_token,model_id,model_version,prompt_version,self_fingerprint,snapshot_max_id,state,total_messages,skipped_messages,created_at_ms,thinking_level,prompt_snapshot,title,processing_snapshot)
          VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)`).run(id(preparation.conversationId), input.requestId, input.token, model.id, model.version, row.prompt_version, self.fingerprint,
          BigInt(preparation.snapshotMaxId), preparation.analyzableMessages, preparation.totalMessages - preparation.analyzableMessages,
          now, preparation.thinkingLevel ?? null, JSON.stringify(readPromptValues(db)), defaultInsightTitle, JSON.stringify(processing)).lastInsertRowid
        db.prepare('INSERT INTO ai_insight_snapshots(task_id,scope,timezone,created_at_ms,source_start_time_ms,source_end_time_ms,sources,source_text_bytes) VALUES(?,?,?,?,?,?,?,?)')
          .run(taskId, JSON.stringify(snapshot.scope), snapshot.timezone, snapshot.createdAtMs, snapshot.sourceStartTimeMs, snapshot.sourceEndTimeMs, JSON.stringify(snapshot.sources), snapshot.sourceTextBytes ?? null)
        db.prepare('UPDATE ai_preparations SET insight_snapshot=NULL WHERE token=?').run(input.token)
        return String(taskId)
      })())
      return repository.getAnalysis(taskId)
    },
    getAnalysis(taskId: string): AnalysisTask { return taskView(analysisRow(taskId)) },
    listAnalyses(conversationId?: string): AnalysisTask[] { if (conversationId !== undefined) conversation(conversationId); return (reader.prepare(`SELECT * FROM ai_analysis_tasks${conversationId === undefined ? '' : ' WHERE conversation_id=?'} ORDER BY pinned DESC,list_rank,id DESC`).all(...(conversationId === undefined ? [] : [id(conversationId)])) as AnalysisRow[]).map(taskView) },
    async arrangeAnalysis(change: ListArrangement): Promise<void> {
      await write(() => db.transaction(() => {
        const row = analysisRow(change.id)
        if ('pinned' in change) {
          if (typeof change.pinned !== 'boolean') fail('INVALID_ARGUMENT')
          db.prepare('UPDATE ai_analysis_tasks SET pinned=?,list_rank=0,event_sequence=event_sequence+1 WHERE id=?').run(Number(change.pinned), row.id)
          return
        }
        const rows = db.prepare('SELECT id FROM ai_analysis_tasks WHERE conversation_id=? AND pinned=? ORDER BY list_rank,id DESC').all(row.conversation_id, row.pinned) as { id: bigint }[]
        const from = rows.findIndex(item => String(item.id) === change.id)
        const [moving] = rows.splice(from, 1)
        const target = rows.findIndex(item => String(item.id) === change.targetId)
        if (target < 0 || !['before', 'after'].includes(change.placement)) fail('INVALID_LIST_ITEM', '请刷新列表后重试。')
        rows.splice(target + Number(change.placement === 'after'), 0, moving)
        const update = db.prepare('UPDATE ai_analysis_tasks SET list_rank=? WHERE id=?')
        rows.forEach((item, index) => update.run(index + 1, item.id))
      })())
    },
    async renameAnalysis(input: { taskId: string; title: string }): Promise<AnalysisTask> {
      validateAiCall('renameAnalysis', [input])
      const title = insightTitle(input.title)!
      await write(() => {
        const row = analysisRow(input.taskId)
        if (row.title !== title) db.prepare('UPDATE ai_analysis_tasks SET title=?,event_sequence=event_sequence+1 WHERE id=?').run(title, row.id)
      })
      return repository.getAnalysis(input.taskId)
    },
    async deleteAnalysis(taskId: string): Promise<void> {
      await write(() => db.transaction(() => {
        const row = analysisRow(taskId)
        if (activeStates.has(row.state)) fail('ANALYSIS_BUSY', '请暂停生成后重试。')
        purgeAnalysis(db, row.id)
      })())
    },
    getReport(taskId: string): InsightReport {
      const row = analysisRow(taskId)
      const saved = reader.prepare('SELECT data,content_revision FROM ai_reports WHERE task_id=?').get(row.id) as ReportRow | undefined
      if (row.state !== 'completed' || !saved) fail('REPORT_UNAVAILABLE', '生成完成后再查看文稿。')
      const report = readInsightReport(saved.data, row.conversation_id)
      let snapshot: StoredInsightSnapshot | undefined
      if (createHash('sha256').update(saved.data).digest('hex') === saved.content_revision) {
        try {
          snapshot = insightSnapshot(row)
        } catch (error) {
          if (!(error instanceof BoundaryError && error.code === 'INSIGHT_SNAPSHOT_UNAVAILABLE')) throw error
        }
      }
      populateReportExcerpts(reader, row.conversation_id, snapshot, report, row.processing_snapshot ? parse<ProcessingSettings>(row.processing_snapshot) : undefined)
      return report
    },
    readInsightSources(input: { taskId: string; messageIds: readonly string[] }) {
      fields(input, ['taskId', 'messageIds'])
      if (!Array.isArray(input.messageIds) || input.messageIds.some(messageId => !localId(messageId))) fail('INVALID_ARGUMENT')
      const row = analysisRow(input.taskId)
      assertCurrent(row)
      return checkedInsightSources(row, insightSnapshot(row), input.messageIds)
    },
    async readInsightCitation(input: InsightCitationInput): Promise<InsightCitationWindow> {
      validateAiCall('readInsightCitation', [input])
      const row = reader.prepare("SELECT * FROM ai_analysis_tasks WHERE id=? AND state='completed'").get(id(input.taskId)) as AnalysisRow | undefined
      if (!row || row.prompt_version !== INSIGHT_PROMPT_VERSION) return { status: 'unavailable' }
      const saved = reader.prepare('SELECT data,content_revision FROM ai_reports WHERE task_id=?').get(row.id) as ReportRow | undefined
      if (!saved) return { status: 'unavailable' }
      if (saved.content_revision !== createHash('sha256').update(saved.data).digest('hex')) return { status: 'expired' }
      const report = readInsightReport(saved.data, row.conversation_id)
      const citation = resolveReportCitation(report, String(row.conversation_id), input.citationId)
      const fragment = citation?.fragments[input.fragmentIndex]
      if (!citation || !fragment || !isInsightCitation({ ...citation, fragments: [fragment] })) return { status: 'unavailable' }
      let highlightIds: string[] | null
      try {
        highlightIds = readInsightCitationIds(reader, row.conversation_id, insightSnapshot(row), fragment.sources)
      } catch (error) {
        if (error instanceof BoundaryError && error.code === 'INSIGHT_SNAPSHOT_UNAVAILABLE') return { status: 'expired' }
        throw error
      }
      if (!highlightIds) return { status: 'expired' }
      if (input.messageId && !highlightIds.includes(input.messageId)) return { status: 'unavailable' }
      const window = await queries.locateSource({ conversationId: citation.conversationId, messageId: highlightIds[0], endMessageId: highlightIds.at(-1)! }, input.messageId)
      return window.status === 'available' ? { ...window, highlightIds } : { status: 'expired' }
    },
    analysisContext(taskId: string): AnalysisContext {
      const row = analysisRow(taskId); assertCurrent(row)
      const model = modelSecret(row.model_id, Number(row.model_version)).model
      const { sources, ...snapshot } = insightSnapshot(row)
      return {
        processing: row.processing_snapshot ? parse<ProcessingSettings>(row.processing_snapshot) : undefined,
        systemPrompts: row.prompt_snapshot ? parse<PromptValues>(row.prompt_snapshot) : undefined,
        task: taskView(row), model, checkpoint: row.checkpoint,
        snapshot: { ...snapshot, sources: sources.map(({ messageId, revision }) => ({ messageId, revision })) },
      }
    },
    async saveAnalysis(taskId: string, patch: AnalysisPatch, sampledAtMs?: number): Promise<AnalysisTask> {
      patchState(patch)
      if (patch.failureOperationId !== undefined && (patch.state !== 'failed' || !isOperationId(patch.failureOperationId))) fail('INVALID_ARGUMENT')
      if (patch.failureAtMs !== undefined && (patch.state !== 'failed' || !Number.isSafeInteger(patch.failureAtMs) || patch.failureAtMs < 0)) fail('INVALID_ARGUMENT')
      await write(() => {
        const row = analysisRow(taskId)
        if (!activeStates.has(row.state)) return
        if (patch.state === 'completed') fail('REPORT_REQUIRED')
        db.prepare('UPDATE ai_analysis_tasks SET state=?,error=?,failure_operation_id=?,failure_at_ms=?,elapsed_ms=?,event_sequence=event_sequence+1 WHERE id=?').run(
          patch.state ?? row.state, Object.hasOwn(patch, 'error') ? patch.error ?? null : row.error,
          patch.failureOperationId ?? null, patch.failureAtMs ?? null,
          insightElapsedAt(row, Date.now(), sampledAtMs), row.id)
      })
      return repository.getAnalysis(taskId)
    },
    async saveInsightElapsed(taskId: string, elapsedMs: number): Promise<AnalysisTask> {
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) fail('INVALID_INSIGHT_CHECKPOINT')
      await write(() => {
        db.prepare("UPDATE ai_analysis_tasks SET elapsed_ms=?,event_sequence=event_sequence+1 WHERE id=? AND prompt_version=? AND state='running' AND elapsed_ms<?")
          .run(elapsedMs, id(taskId), INSIGHT_PROMPT_VERSION, elapsedMs)
      })
      return repository.getAnalysis(taskId)
    },
    async saveInsightCheckpoint(taskId: string, checkpoint: string, completedMessageIds: readonly string[], elapsedMs?: number, receipt?: Pick<UsageRecord, 'requestId' | 'usage'>): Promise<AnalysisTask> {
      if (!text(checkpoint, 16 * 1024 * 1024) || !Array.isArray(completedMessageIds) || completedMessageIds.some(messageId => !localId(messageId)) ||
        (elapsedMs !== undefined && (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0))) fail('INVALID_INSIGHT_CHECKPOINT', '请继续分析。')
      const coverage = new Set(completedMessageIds)
      if (coverage.size !== completedMessageIds.length) fail('INVALID_INSIGHT_CHECKPOINT', '请继续分析。')
      await write(() => db.transaction(() => {
        const row = analysisRow(taskId)
        if (!activeStates.has(row.state)) return
        assertCurrent(row)
        const snapshot = insightSnapshot(row)
        const previous = new Set((db.prepare('SELECT message_id FROM ai_analysis_coverage WHERE task_id=?').all(row.id) as { message_id: bigint }[]).map(source => String(source.message_id)))
        if ([...previous].some(messageId => !coverage.has(messageId)) || (elapsedMs !== undefined && BigInt(elapsedMs) < row.elapsed_ms)) {
          fail('INVALID_INSIGHT_CHECKPOINT', '请继续分析。')
        }
        const added = completedMessageIds.filter(messageId => !previous.has(messageId))
        if (added.length) checkedInsightSources(row, snapshot, added)
        const elapsed = elapsedMs ?? row.elapsed_ms
        if (receipt) insertUsage({ ownerKind: 'analysis', ownerId: taskId, requestId: receipt.requestId, usage: receipt.usage })
        if (!receipt && !added.length && checkpoint === row.checkpoint && BigInt(elapsed) === row.elapsed_ms) return
        const cover = db.prepare('INSERT INTO ai_analysis_coverage(task_id,message_id) VALUES(?,?)')
        for (const messageId of added) cover.run(row.id, id(messageId))
        db.prepare('UPDATE ai_analysis_tasks SET checkpoint=?,elapsed_ms=?,event_sequence=event_sequence+1 WHERE id=?').run(checkpoint, elapsed, row.id)
      })())
      return repository.getAnalysis(taskId)
    },
    async completeAnalysis(taskId: string, report: InsightReport, sampledAtMs?: number): Promise<AnalysisTask> {
      await write(() => db.transaction(() => {
        const row = analysisRow(taskId); if (!activeStates.has(row.state)) return; assertCurrent(row)
        if (!isInsightReport(report)) fail('INVALID_REPORT', '请重新生成这份报告。')
        validateAiResult('getReport', report)
        const snapshot = insightSnapshot(row)
        const current = checkedInsightSources(row, snapshot, snapshot.sources.map(source => source.messageId))
        validateInsightReport(row, report, current)
        const covered = db.prepare('SELECT count(*) AS n FROM ai_analysis_coverage WHERE task_id=?').get(row.id) as { n: bigint }
        if (covered.n !== row.total_messages) fail('ANALYSIS_INCOMPLETE', '请继续分析剩余消息。')
        const data = JSON.stringify(report)
        const revision = createHash('sha256').update(data).digest('hex')
        db.prepare('INSERT INTO ai_reports(task_id,data,content_revision) VALUES(?,?,?)').run(row.id, data, revision)
        const completedAtMs = Date.now()
        db.prepare("UPDATE ai_analysis_tasks SET state='completed',completed_at_ms=?,elapsed_ms=?,error=NULL,event_sequence=event_sequence+1 WHERE id=?")
          .run(completedAtMs, insightElapsedAt(row, completedAtMs, sampledAtMs), row.id)
      })())
      return repository.getAnalysis(taskId)
    },
    async resumeAnalysis(taskId: string): Promise<AnalysisTask> {
      await write(() => {
        const row = analysisRow(taskId); assertCurrent(row)
        if (!['stopped', 'failed', 'interrupted'].includes(row.state)) fail('INVALID_STATE')
        insightSnapshot(row)
        if (!sameModelConfiguration(row.model_id, Number(row.model_version))) fail('MODEL_CHANGED', '模型配置已更新，请重新准备分析。')
        if (db.prepare("SELECT 1 FROM ai_analysis_tasks WHERE conversation_id=? AND state IN ('queued','running')").get(row.conversation_id)) fail('ANALYSIS_BUSY')
        db.prepare("UPDATE ai_analysis_tasks SET state='queued',error=NULL,failure_operation_id=NULL,failure_at_ms=NULL,event_sequence=event_sequence+1 WHERE id=?").run(row.id)
      })
      return repository.getAnalysis(taskId)
    },
    async openThread(conversationId: string): Promise<AiThread> {
      conversation(conversationId)
      const threadId = await write(() => {
        const existing = db.prepare('SELECT id FROM ai_threads WHERE conversation_id=? ORDER BY updated_at_ms DESC,id DESC LIMIT 1').get(id(conversationId)) as { id: bigint } | undefined
        if (existing) return String(existing.id)
        const now = Date.now()
        return String(db.prepare('INSERT INTO ai_threads(conversation_id,created_at_ms,updated_at_ms) VALUES(?,?,?)').run(id(conversationId), now, now).lastInsertRowid)
      })
      return repository.getThread(threadId)
    },
    listThreads(conversationId: string): AiThreadSummary[] {
      conversation(conversationId)
      return (reader.prepare(`SELECT * FROM ai_threads WHERE conversation_id=? ORDER BY ${threadOrder}`).all(id(conversationId)) as ThreadRow[]).map(threadView)
    },
    async arrangeThread(conversationId: string, change: ListArrangement): Promise<void> {
      await write(() => arrangeList(db, change, conversationId))
    },
    async deleteThread(conversationId: string, threadId: string): Promise<void> {
      await write(() => db.transaction(() => {
        if (threadConversation(threadId) !== conversationId) fail('INVALID_THREAD', '请重新打开对话。')
        purgeThread(db, id(threadId))
      })())
    },
    async createThread(conversationId: string): Promise<AiThread> {
      conversation(conversationId)
      const threadId = await write(() => {
        const now = Date.now()
        return String(db.prepare('INSERT INTO ai_threads(conversation_id,created_at_ms,updated_at_ms) VALUES(?,?,?)').run(id(conversationId), now, now).lastInsertRowid)
      })
      return repository.getThread(threadId)
    },
    getThread(threadId: string): AiThread {
      const row = reader.prepare('SELECT * FROM ai_threads WHERE id=?').get(id(threadId)) as ThreadRow | undefined
      if (!row) fail('INVALID_THREAD', '请重新打开对话。')
      return { ...threadView(row), turns: (reader.prepare('SELECT * FROM ai_turns WHERE thread_id=? ORDER BY id').all(row.id) as TurnRow[]).map(turnView) }
    },
    async createTurn(input: NewTurn): Promise<AiTurn> {
      fields(input, ['threadId', 'requestId', 'prompt', 'referenceIds', 'modelId', 'skillId', 'thinkingLevel']); if (input.thinkingLevel !== undefined && !isThinkingLevel(input.thinkingLevel)) fail('INVALID_ARGUMENT')
      if (!key(input.requestId) || !text(input.prompt, 65536) || !input.prompt.trim()) fail('INVALID_ARGUMENT')
      const turnId = await write(() => db.transaction(() => {
        const conversationId = threadConversation(input.threadId)
        const existing = db.prepare('SELECT * FROM ai_turns WHERE thread_id=? AND request_id=?').get(id(input.threadId), input.requestId) as TurnRow | undefined
        if (existing) {
          const skill = existing.skill ? parse<RegisteredSkill>(existing.skill) : null
          if (existing.prompt !== input.prompt || existing.reference_ids !== JSON.stringify(input.referenceIds) || existing.model_id !== input.modelId || existing.thinking_level !== (input.thinkingLevel ?? null) || skill?.id !== input.skillId) fail('REQUEST_CONFLICT')
          return String(existing.id)
        }
        sources(conversationId, input.referenceIds)
        const model = enabledModel(input.modelId), self = identity(conversationId)
        let skill: RegisteredSkill | null = null
        if (input.skillId !== undefined) {
          if (!input.referenceIds.length || !key(input.skillId)) fail('INVALID_SKILL')
          const row = db.prepare('SELECT data FROM ai_skills WHERE id=?').get(input.skillId) as { data: string } | undefined
          if (!row || parse<RegisteredSkill>(row.data).enabled === false) fail('INVALID_SKILL', '请选择可用技能。')
          skill = parse<RegisteredSkill>(row.data)
        }
        if (db.prepare("SELECT 1 FROM ai_turns WHERE thread_id=? AND state IN ('queued','running')").get(id(input.threadId))) fail('TURN_BUSY', '请等待回答完成或先停止回答。')
        const first = !db.prepare('SELECT 1 FROM ai_turns WHERE thread_id=? LIMIT 1').get(id(input.threadId))
        const turnId = String(db.prepare("INSERT INTO ai_turns(thread_id,request_id,prompt,reference_ids,model_id,model_version,skill,self_fingerprint,state,thinking_level,system_prompt) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)").run(id(input.threadId), input.requestId, input.prompt, JSON.stringify(input.referenceIds), model.id, model.version, skill ? JSON.stringify(skill) : null, self.fingerprint, input.thinkingLevel ?? null, readPromptValues(db).dialogue).lastInsertRowid)
        db.prepare('UPDATE ai_threads SET title=CASE WHEN ? THEN ? ELSE title END,updated_at_ms=max(updated_at_ms,?) WHERE id=?').run(first ? 1 : 0, threadTitle(input.prompt), Date.now(), id(input.threadId))
        return turnId
      })())
      return turnView(turnRow(turnId))
    },
    turnContext(turnId: string, processing?: ProcessingSettings): TurnContext {
      if (processing !== undefined) validateProcessing(processing)
      const row = turnRow(turnId), conversationId = threadConversation(String(row.thread_id)), self = identity(conversationId)
      if (row.self_fingerprint !== self.fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新提问。')
      const previous = reader.prepare("SELECT * FROM ai_turns WHERE thread_id=? AND id<? AND state='completed' AND self_fingerprint=? ORDER BY id").all(row.thread_id, row.id, self.fingerprint) as TurnRow[]
      const history: TurnContext['history'] = []
      for (const turn of previous) {
        const material = sources(conversationId, parse<string[]>(turn.reference_ids))
        history.push({ role: 'user', text: turn.prompt, ...(material.references.length ? material : {}) }, { role: 'assistant', text: turn.text })
      }
      const latest = previous.at(-1), skill = row.skill ? parse<RegisteredSkill>(row.skill) : null
      const sameCheckpointContext = latest?.model_id === row.model_id && latest?.model_version === row.model_version && latest?.skill === row.skill && (latest?.system_prompt ?? defaultPrompts.dialogue) === (row.system_prompt ?? defaultPrompts.dialogue)
      const profile = repository.listAnalyses(conversationId).find(task => task.state === 'completed' && task.valid && task.report)?.report ?? null
      if (profile) prepareTurnProfile(reader, id(conversationId), profile, processing)
      return { systemPrompt: row.system_prompt ?? defaultPrompts.dialogue, turn: turnView(row), threadId: String(row.thread_id), conversationId, model: modelSecret(row.model_id, Number(row.model_version)).model, selfFingerprint: self.fingerprint, ...sources(conversationId, parse<string[]>(row.reference_ids)), history, profile, skill, checkpoint: sameCheckpointContext ? latest!.checkpoint : null }
    },
    async saveTurn(turnId: string, patch: TurnPatch): Promise<AiTurn> {
      patchState(patch, true)
      if (patch.text !== undefined && (typeof patch.text !== 'string' || patch.text.length > 8 * 1024 ** 2)) fail('INVALID_ARGUMENT')
      await write(() => {
        const row = turnRow(turnId); if (!activeStates.has(row.state)) return
        if ((patch.text !== undefined || patch.state === 'completed') && identity(threadConversation(String(row.thread_id))).fingerprint !== row.self_fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新提问。')
        db.prepare('UPDATE ai_turns SET state=?,text=?,error=?,checkpoint=?,event_sequence=event_sequence+1 WHERE id=?').run(patch.state ?? row.state, patch.text ?? row.text, Object.hasOwn(patch, 'error') ? patch.error ?? null : row.error, patch.checkpoint === undefined ? row.checkpoint : patch.checkpoint, row.id)
        db.prepare('UPDATE ai_threads SET updated_at_ms=max(updated_at_ms,?) WHERE id=?').run(Date.now(), row.thread_id)
        if (patch.usage) insertUsage({ ownerKind: 'turn', ownerId: turnId, requestId: `snapshot:${row.attempt}`, usage: patch.usage })
      })
      return turnView(turnRow(turnId))
    },
    async beginRetryTurn(turnId: string): Promise<AiTurn> {
      await write(() => {
        const row = turnRow(turnId)
        if (!['stopped', 'failed', 'interrupted'].includes(row.state)) fail('INVALID_STATE')
        const conversationId = threadConversation(String(row.thread_id))
        if (identity(conversationId).fingerprint !== row.self_fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新提问。')
        if (!sameModelConfiguration(row.model_id, Number(row.model_version))) fail('MODEL_CHANGED', '模型配置已更新，请重新提问。')
        if (db.prepare('SELECT 1 FROM ai_turns WHERE thread_id=? AND id>? LIMIT 1').get(row.thread_id, row.id)) fail('INVALID_STATE', '请重新发送提问。')
        sources(conversationId, parse<string[]>(row.reference_ids))
        db.prepare("UPDATE ai_turns SET state='queued',text='',error=NULL,checkpoint=NULL,attempt=attempt+1,event_sequence=event_sequence+1 WHERE id=?").run(row.id)
        db.prepare('UPDATE ai_threads SET updated_at_ms=max(updated_at_ms,?) WHERE id=?').run(Date.now(), row.thread_id)
      })
      return turnView(turnRow(turnId))
    },
    async recordUsage(record: UsageRecord): Promise<AnalysisTask | AiTurn> {
      await write(() => db.transaction(() => { insertUsage(record); db.prepare(`UPDATE ${record.ownerKind === 'analysis' ? 'ai_analysis_tasks' : 'ai_turns'} SET event_sequence=event_sequence+1 WHERE id=?`).run(id(record.ownerId)) })())
      return record.ownerKind === 'analysis' ? repository.getAnalysis(record.ownerId) : turnView(turnRow(record.ownerId))
    },
    async recover(): Promise<void> {
      await write(() => db.transaction(() => {
        discardExpiredPreparations(Date.now())
        db.prepare("UPDATE ai_analysis_tasks SET state='interrupted',event_sequence=event_sequence+1 WHERE state IN ('queued','running')").run()
        db.prepare("UPDATE ai_turns SET state='interrupted',event_sequence=event_sequence+1 WHERE state IN ('queued','running')").run()
      })())
    },
  }
  return repository
}
export type AiRepository = ReturnType<typeof createAiRepository>
