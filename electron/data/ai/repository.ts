import { createHash, randomUUID } from 'node:crypto'
import type { Store } from '../db/open'
import type { WriterQueue } from '../import/runner'
import { confirmedSelfSql } from '../db/self'
import { ANALYSIS_PROMPT_VERSION } from './prompt-version'
import { BoundaryError, localId } from '../../../src/shared/desktop-validation'
import type { AiModel, AiReport, AiSkill, AiState, AiThread, AiTurn, AiUsage, AnalysisPreparation, AnalysisTask } from '../../../src/shared/ai-contract'

export type AiSourceMessage = { id: string; senderName: string; text: string; isSelf: boolean; kind: string }
export type AnalysisBatch = { index: number; messageIds: string[]; report: AiReport; usage: AiUsage }
export type AnalysisContext = { task: AnalysisTask; model: AiModel; selfFingerprint: string; messages: AiSourceMessage[]; batches: AnalysisBatch[]; checkpoint: string | null }
export type RegisteredSkill = AiSkill & { content: string; enabled?: boolean }
export type TurnContext = { turn: AiTurn; threadId: string; conversationId: string; model: AiModel; selfFingerprint: string; references: AiSourceMessage[]; history: { role: 'user' | 'assistant'; text: string }[]; profile: AiReport | null; skill: RegisteredSkill | null; checkpoint: string | null }
export type AnalysisPatch = { state?: AiState; error?: string; usage?: AiUsage; checkpoint?: string | null }
export type TurnPatch = AnalysisPatch & { text?: string }
export type NewTurn = { threadId: string; requestId: string; prompt: string; referenceIds: string[]; modelId: string; skillId?: string }
export type ModelInput = Omit<AiModel, 'version' | 'hasCredential'>
export type UsageRecord = { ownerKind: 'analysis' | 'turn'; ownerId: string; requestId: string; usage: AiUsage }
type AnalysisRow = { id: bigint; conversation_id: bigint; model_id: string; model_version: bigint; prompt_version: string; self_fingerprint: string; snapshot_max_id: bigint; state: AiState; total_messages: bigint; skipped_messages: bigint; event_sequence: bigint; error: string | null; checkpoint: string | null }
type TurnRow = { id: bigint; thread_id: bigint; request_id: string; prompt: string; reference_ids: string; model_id: string; model_version: bigint; skill: string | null; self_fingerprint: string; text: string; state: AiState; attempt: bigint; event_sequence: bigint; error: string | null; checkpoint: string | null }
const activeStates = new Set<AiState>(['queued', 'running', 'summarizing'])
const states = new Set<AiState>([...activeStates, 'completed', 'stopped', 'failed', 'interrupted'])
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
const usageFields = [...tokenFields, 'durationMs', 'firstTokenMs', 'outputTokensPerSecond'] as const
function fail(code: string, action = '请检查输入后重试。'): never { throw new BoundaryError(code, action) }
function id(value: unknown): bigint { if (!localId(value)) fail('INVALID_ID'); return BigInt(value as string) }
function text(value: unknown, max = 1024 * 1024): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function key(value: unknown): value is string { return text(value, 256) }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> { if (!object(value) || Object.keys(value).some(field => !allowed.includes(field))) fail('INVALID_ARGUMENT') }
function parse<T>(value: string): T { return JSON.parse(value) as T }
function usage(value: AiUsage): AiUsage {
  fields(value, [...usageFields, 'incomplete'])
  for (const field of usageFields) if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field]! < 0)) fail('INVALID_USAGE')
  for (const field of tokenFields) if (value[field] !== undefined && !Number.isSafeInteger(value[field])) fail('INVALID_USAGE')
  if (value.incomplete !== undefined && typeof value.incomplete !== 'boolean') fail('INVALID_USAGE')
  return value
}
function validateReport(value: AiReport, allowed: Set<string>) {
  fields(value, ['summary', 'observations', 'limitations'])
  if (!text(value.summary) || typeof value.limitations !== 'string' || value.limitations.length > 1024 * 1024 || !Array.isArray(value.observations) || value.observations.length > 1000) fail('INVALID_REPORT', '分析结果格式不完整，请重试。')
  for (const observation of value.observations) {
    fields(observation, ['text', 'evidenceMessageIds', 'limitations'])
    if (!text(observation.text) || typeof observation.limitations !== 'string' || !Array.isArray(observation.evidenceMessageIds) || !observation.evidenceMessageIds.length || observation.evidenceMessageIds.some(message => !allowed.has(message))) fail('INVALID_EVIDENCE', '分析依据无效，请重新分析。')
  }
}

export function createAiRepository(store: Store, write: WriterQueue) {
  const db = store.writer, reader = store.reader
  function conversation(conversationId: string) {
    const row = reader.prepare('SELECT title FROM conversations WHERE id=?').get(id(conversationId)) as { title: string } | undefined
    if (!row) fail('INVALID_ID', '请刷新会话列表后重试。')
    return row
  }
  function identity(conversationId: string) {
    conversation(conversationId)
    const confirmation = reader.prepare(`SELECT s.id,s.member_id,m.display_name FROM self_confirmations s JOIN memberships m ON m.id=s.member_id AND m.conversation_id=s.conversation_id WHERE s.conversation_id=? AND s.status='confirmed' AND s.source='user' AND NOT EXISTS(SELECT 1 FROM self_opt_outs o WHERE o.conversation_id=s.conversation_id)`).get(id(conversationId)) as { id: bigint; member_id: bigint; display_name: string } | undefined
    const members = reader.prepare(`SELECT m.id,m.account_id FROM memberships m WHERE m.conversation_id=? AND ${confirmedSelfSql} ORDER BY m.id`).all(id(conversationId)) as { id: bigint; account_id: bigint | null }[]
    const fingerprint = createHash('sha256').update(JSON.stringify({ confirmation: confirmation ? String(confirmation.id) : null, members: members.map(member => [String(member.id), member.account_id === null ? null : String(member.account_id)]) })).digest('hex')
    return { fingerprint, selfName: confirmation?.display_name ?? null }
  }
  function modelSecret(modelId: string, version?: number): { model: AiModel; encryptedKey: string | null } {
    if (!key(modelId) || (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) fail('INVALID_MODEL')
    const row = (version === undefined ? reader.prepare('SELECT data,encrypted_key FROM ai_models WHERE id=?').get(modelId) : reader.prepare('SELECT data,encrypted_key FROM ai_model_versions WHERE model_id=? AND version=?').get(modelId, version)) as { data: string; encrypted_key: string | null } | undefined
    if (!row) fail('INVALID_MODEL', '请配置可用模型。')
    return { model: parse<AiModel>(row.data), encryptedKey: row.encrypted_key }
  }
  function enabledModel(modelId: string): AiModel { const model = modelSecret(modelId).model; if (!model.enabled) fail('INVALID_MODEL', '请选择可用模型。'); return model }
  function analysisRow(taskId: string): AnalysisRow {
    const row = reader.prepare('SELECT * FROM ai_analysis_tasks WHERE id=?').get(id(taskId)) as AnalysisRow | undefined
    if (!row) fail('INVALID_TASK', '请刷新分析任务后重试。')
    return row
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
  function messages(conversationId: string, snapshot?: bigint): AiSourceMessage[] {
    const rows = reader.prepare(`SELECT x.id,x.sender_name,x.text,x.kind,coalesce((SELECT ${confirmedSelfSql} FROM memberships m WHERE m.id=x.member_id AND m.conversation_id=x.conversation_id),0) AS is_self FROM messages x WHERE x.conversation_id=?${snapshot === undefined ? '' : ' AND x.id<=?'} ORDER BY x.time_bucket,x.sort_time,x.id`).all(id(conversationId), ...(snapshot === undefined ? [] : [snapshot])) as { id: bigint; sender_name: string; text: string; kind: string; is_self: bigint }[]
    return rows.map(row => ({ id: String(row.id), senderName: row.sender_name, text: row.text, kind: row.kind, isSelf: row.is_self === 1n }))
  }
  function analyzable(message: AiSourceMessage) { return message.kind !== 'system' && !!message.text.trim() }
  function sources(conversationId: string, messageIds: string[]) {
    if (!Array.isArray(messageIds) || messageIds.length > 10000 || messageIds.some(message => !localId(message)) || new Set(messageIds).size !== messageIds.length) fail('INVALID_REFERENCE')
    const result = new Map<string, AiSourceMessage>()
    const fetch = reader.prepare(`SELECT x.id,x.sender_name,x.text,x.kind,coalesce((SELECT ${confirmedSelfSql} FROM memberships m WHERE m.id=x.member_id AND m.conversation_id=x.conversation_id),0) AS is_self FROM messages x WHERE x.conversation_id=? AND x.id=?`)
    for (const messageId of messageIds) {
      const row = fetch.get(id(conversationId), id(messageId)) as { id: bigint; sender_name: string; text: string; kind: string; is_self: bigint } | undefined
      if (!row) fail('INVALID_REFERENCE', '请选择当前会话中的消息。')
      result.set(messageId, { id: String(row.id), senderName: row.sender_name, text: row.text, kind: row.kind, isSelf: row.is_self === 1n })
    }
    return messageIds.map(messageId => result.get(messageId)!)
  }
  function aggregate(kind: 'analysis' | 'turn', ownerId: string): AiUsage {
    const records = reader.prepare('SELECT data FROM ai_request_usage WHERE owner_kind=? AND owner_id=? ORDER BY request_id').all(kind, id(ownerId)) as { data: string }[]
    if (!records.length) return {}
    const values = records.map(row => parse<AiUsage>(row.data)), result: AiUsage = {}
    for (const field of [...tokenFields, 'durationMs'] as const) {
      const reported = values.filter(value => value[field] !== undefined)
      if (reported.length) result[field] = reported.reduce((sum, value) => sum + value[field]!, 0)
    }
    if (values.some(value => value.incomplete || value.inputTokens === undefined || value.outputTokens === undefined)) result.incomplete = true
    if (result.outputTokens !== undefined && result.durationMs && result.durationMs > 0) result.outputTokensPerSecond = result.outputTokens / (result.durationMs / 1000)
    if (values.length === 1 && values[0].firstTokenMs !== undefined) result.firstTokenMs = values[0].firstTokenMs
    return result
  }
  function taskView(row: AnalysisRow): AnalysisTask {
    const coverage = reader.prepare('SELECT count(*) AS n FROM ai_analysis_coverage WHERE task_id=?').get(row.id) as { n: bigint }
    const report = reader.prepare('SELECT data FROM ai_reports WHERE task_id=?').get(row.id) as { data: string } | undefined
    return { id: String(row.id), conversationId: String(row.conversation_id), modelId: row.model_id, state: row.state, analyzedMessages: Number(coverage.n), totalMessages: Number(row.total_messages), skippedMessages: Number(row.skipped_messages), usage: aggregate('analysis', String(row.id)), valid: row.self_fingerprint === identity(String(row.conversation_id)).fingerprint, eventSequence: Number(row.event_sequence), ...(row.error ? { error: row.error } : {}), ...(report ? { report: parse<AiReport>(report.data) } : {}) }
  }
  function turnView(row: TurnRow): AiTurn {
    const skill = row.skill ? parse<RegisteredSkill>(row.skill) : null
    return { id: String(row.id), threadId: String(row.thread_id), requestId: row.request_id, prompt: row.prompt, referenceIds: parse<string[]>(row.reference_ids), modelId: row.model_id, ...(skill ? { skillId: skill.id } : {}), text: row.text, state: row.state, attempt: Number(row.attempt), usage: aggregate('turn', String(row.id)), eventSequence: Number(row.event_sequence), ...(row.error ? { error: row.error } : {}) }
  }
  function assertCurrent(row: AnalysisRow) {
    if (row.prompt_version !== ANALYSIS_PROMPT_VERSION) fail('PROMPT_CHANGED', '请重新准备分析。')
    if (row.self_fingerprint !== identity(String(row.conversation_id)).fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新准备分析。')
  }
  function insertUsage(record: UsageRecord) {
    fields(record, ['ownerKind', 'ownerId', 'requestId', 'usage'])
    if (!['analysis', 'turn'].includes(record.ownerKind) || !key(record.requestId)) fail('INVALID_ARGUMENT')
    usage(record.usage)
    if (record.ownerKind === 'analysis') analysisRow(record.ownerId); else turnRow(record.ownerId)
    db.prepare('INSERT INTO ai_request_usage(owner_kind,owner_id,request_id,data) VALUES(?,?,?,?) ON CONFLICT(owner_kind,owner_id,request_id) DO UPDATE SET data=excluded.data').run(record.ownerKind, id(record.ownerId), record.requestId, JSON.stringify(record.usage))
  }
  function patchState(patch: AnalysisPatch, turn = false) {
    fields(patch, ['state', 'error', 'usage', 'checkpoint', ...(turn ? ['text'] : [])])
    if (patch.state !== undefined && !states.has(patch.state)) fail('INVALID_STATE')
    if (patch.error !== undefined && (typeof patch.error !== 'string' || patch.error.length > 4096)) fail('INVALID_ARGUMENT')
    if (patch.checkpoint !== undefined && patch.checkpoint !== null && !text(patch.checkpoint, 32768)) fail('INVALID_ARGUMENT')
    if (patch.usage !== undefined) usage(patch.usage)
  }
  const repository = {
    listModels(): AiModel[] { return (reader.prepare('SELECT data FROM ai_models ORDER BY id').all() as { data: string }[]).map(row => parse<AiModel>(row.data)) },
    async saveModel(input: ModelInput, encryptedKey?: string | null): Promise<AiModel> {
      fields(input, ['id', 'label', 'model', 'baseUrl', 'contextWindow', 'maxTokens', 'enabled', 'version', 'hasCredential'])
      if (!key(input.id) || !text(input.label, 256) || !key(input.model) || !text(input.baseUrl, 4096) || !Number.isSafeInteger(input.contextWindow) || input.contextWindow < 256 || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens >= input.contextWindow || typeof input.enabled !== 'boolean' || !(encryptedKey === undefined || encryptedKey === null || text(encryptedKey, 65536))) fail('INVALID_MODEL')
      try { const url = new URL(input.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('INVALID_MODEL') } catch { fail('INVALID_MODEL') }
      return write(() => db.transaction(() => {
        const previous = db.prepare('SELECT version,encrypted_key FROM ai_models WHERE id=?').get(input.id) as { version: bigint; encrypted_key: string | null } | undefined
        const secret = encryptedKey === undefined ? previous?.encrypted_key ?? null : encryptedKey
        const model: AiModel = { id: input.id, label: input.label, model: input.model, baseUrl: input.baseUrl, contextWindow: input.contextWindow, maxTokens: input.maxTokens, enabled: input.enabled, version: Number(previous?.version ?? 0n) + 1, hasCredential: secret !== null }
        db.prepare('INSERT INTO ai_models(id,version,data,encrypted_key) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data,encrypted_key=excluded.encrypted_key').run(model.id, model.version, JSON.stringify(model), secret)
        db.prepare('INSERT INTO ai_model_versions(model_id,version,data,encrypted_key) VALUES(?,?,?,?)').run(model.id, model.version, JSON.stringify(model), secret)
        return model
      })())
    },
    modelSecret,
    listSkills(): AiSkill[] { return (reader.prepare('SELECT data FROM ai_skills ORDER BY id').all() as { data: string }[]).map(row => parse<RegisteredSkill>(row.data)).filter(skill => skill.enabled !== false).map(({ id: skillId, label, version }) => ({ id: skillId, label, version })) },
    async registerSkill(skill: RegisteredSkill) {
      fields(skill, ['id', 'label', 'version', 'content', 'enabled'])
      if (!key(skill.id) || !text(skill.label, 256) || !key(skill.version) || !text(skill.content) || (skill.enabled !== undefined && typeof skill.enabled !== 'boolean')) fail('INVALID_SKILL')
      return write(() => { db.prepare('INSERT INTO ai_skills(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(skill.id, JSON.stringify(skill)); return { id: skill.id, label: skill.label, version: skill.version } })
    },
    async prepareAnalysis(input: { conversationId: string; modelId: string }, now = Date.now()): Promise<AnalysisPreparation> {
      fields(input, ['conversationId', 'modelId'])
      return write(() => {
        const { title } = conversation(input.conversationId), self = identity(input.conversationId)
        if (!self.selfName) fail('SELF_REQUIRED', '请先确认当前会话中的本人身份。')
        const model = enabledModel(input.modelId), all = messages(input.conversationId)
        if (!all.length) fail('EMPTY_CONVERSATION', '巧妇难为无米之炊，先导入一些聊天记录吧。')
        const usable = all.filter(analyzable)
        if (!usable.length) fail('NO_ANALYZABLE_MESSAGES', '请导入包含文字的聊天记录。')
        const snapshotMaxId = all.reduce((max, message) => BigInt(message.id) > max ? BigInt(message.id) : max, 0n).toString()
        const preparation: AnalysisPreparation = { token: randomUUID(), conversationId: input.conversationId, title, selfName: self.selfName, totalMessages: all.length, analyzableMessages: usable.length, snapshotMaxId, expiresAt: now + 5 * 60 * 1000, model }
        db.prepare('INSERT INTO ai_preparations(token,conversation_id,data,self_fingerprint,model_version,prompt_version,expires_at_ms) VALUES(?,?,?,?,?,?,?)').run(preparation.token, id(input.conversationId), JSON.stringify(preparation), self.fingerprint, model.version, ANALYSIS_PROMPT_VERSION, preparation.expiresAt)
        return preparation
      })
    },
    async confirmAnalysis(input: { token: string; requestId: string }, now = Date.now()): Promise<AnalysisTask> {
      fields(input, ['token', 'requestId']); if (!key(input.token) || !key(input.requestId)) fail('INVALID_ARGUMENT')
      const taskId = await write(() => db.transaction(() => {
        const existing = db.prepare('SELECT id,preparation_token FROM ai_analysis_tasks WHERE request_id=?').get(input.requestId) as { id: bigint; preparation_token: string } | undefined
        if (existing) { if (existing.preparation_token !== input.token) fail('REQUEST_CONFLICT'); return String(existing.id) }
        if (db.prepare('SELECT 1 FROM ai_analysis_tasks WHERE preparation_token=?').get(input.token)) fail('CONFIRMATION_USED', '请重新准备分析。')
        const row = db.prepare('SELECT data,self_fingerprint,prompt_version,expires_at_ms FROM ai_preparations WHERE token=?').get(input.token) as { data: string; self_fingerprint: string; prompt_version: string; expires_at_ms: bigint } | undefined
        if (!row || Number(row.expires_at_ms) <= now) fail('CONFIRMATION_EXPIRED', '请重新准备分析。')
        if (row.prompt_version !== ANALYSIS_PROMPT_VERSION) fail('PROMPT_CHANGED', '请重新准备分析。')
        const preparation = parse<AnalysisPreparation>(row.data), self = identity(preparation.conversationId), model = enabledModel(preparation.model.id)
        if (self.fingerprint !== row.self_fingerprint || model.version !== preparation.model.version) fail('CONFIRMATION_CHANGED', '配置或本人身份已更新，请重新准备分析。')
        if (db.prepare("SELECT 1 FROM ai_analysis_tasks WHERE conversation_id=? AND state IN ('queued','running','summarizing')").get(id(preparation.conversationId))) fail('ANALYSIS_BUSY', '请先完成或停止当前分析。')
        return String(db.prepare("INSERT INTO ai_analysis_tasks(conversation_id,request_id,preparation_token,model_id,model_version,prompt_version,self_fingerprint,snapshot_max_id,state,total_messages,skipped_messages) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)").run(id(preparation.conversationId), input.requestId, input.token, model.id, model.version, ANALYSIS_PROMPT_VERSION, self.fingerprint, BigInt(preparation.snapshotMaxId), preparation.analyzableMessages, preparation.totalMessages - preparation.analyzableMessages).lastInsertRowid)
      })())
      return repository.getAnalysis(taskId)
    },
    getAnalysis(taskId: string): AnalysisTask { return taskView(analysisRow(taskId)) },
    listAnalyses(conversationId?: string): AnalysisTask[] { if (conversationId !== undefined) conversation(conversationId); return (reader.prepare(`SELECT * FROM ai_analysis_tasks${conversationId === undefined ? '' : ' WHERE conversation_id=?'} ORDER BY id DESC`).all(...(conversationId === undefined ? [] : [id(conversationId)])) as AnalysisRow[]).map(taskView) },
    getReport(taskId: string): AiReport { const task = repository.getAnalysis(taskId); if (task.state !== 'completed' || !task.report) fail('REPORT_UNAVAILABLE', '分析完成后再查看结果。'); return task.report },
    analysisContext(taskId: string): AnalysisContext {
      const row = analysisRow(taskId); assertCurrent(row)
      const model = modelSecret(row.model_id, Number(row.model_version)).model
      return { task: taskView(row), model, selfFingerprint: row.self_fingerprint, messages: messages(String(row.conversation_id), row.snapshot_max_id).filter(analyzable), batches: (reader.prepare('SELECT data FROM ai_analysis_batches WHERE task_id=? ORDER BY batch_index').all(row.id) as { data: string }[]).map(batch => parse<AnalysisBatch>(batch.data)), checkpoint: row.checkpoint }
    },
    async saveAnalysis(taskId: string, patch: AnalysisPatch): Promise<AnalysisTask> {
      patchState(patch)
      await write(() => {
        const row = analysisRow(taskId)
        if (!activeStates.has(row.state)) return
        if (patch.state === 'completed') fail('REPORT_REQUIRED')
        db.prepare('UPDATE ai_analysis_tasks SET state=?,error=?,checkpoint=?,event_sequence=event_sequence+1 WHERE id=?').run(patch.state ?? row.state, Object.hasOwn(patch, 'error') ? patch.error ?? null : row.error, patch.checkpoint === undefined ? row.checkpoint : patch.checkpoint, row.id)
        if (patch.usage) insertUsage({ ownerKind: 'analysis', ownerId: taskId, requestId: 'snapshot', usage: patch.usage })
      })
      return repository.getAnalysis(taskId)
    },
    async commitBatch(taskId: string, batch: AnalysisBatch & { requestId?: string }): Promise<AnalysisTask> {
      fields(batch, ['index', 'messageIds', 'report', 'usage', 'requestId'])
      if (!Number.isSafeInteger(batch.index) || batch.index < 0 || !Array.isArray(batch.messageIds) || new Set(batch.messageIds).size !== batch.messageIds.length) fail('INVALID_BATCH')
      usage(batch.usage)
      await write(() => db.transaction(() => {
        const row = analysisRow(taskId); if (!activeStates.has(row.state)) return; assertCurrent(row)
        const allowed = new Set(messages(String(row.conversation_id), row.snapshot_max_id).filter(analyzable).map(message => message.id))
        if (batch.messageIds.some(message => !allowed.has(message))) fail('INVALID_REFERENCE')
        validateReport(batch.report, allowed)
        const previous = db.prepare('SELECT data FROM ai_analysis_batches WHERE task_id=? AND batch_index=?').get(row.id, batch.index) as { data: string } | undefined
        const data: AnalysisBatch = { index: batch.index, messageIds: batch.messageIds, report: batch.report, usage: batch.usage }
        if (previous) { if (JSON.stringify(parse<AnalysisBatch>(previous.data).messageIds) !== JSON.stringify(batch.messageIds)) fail('BATCH_CONFLICT'); return }
        db.prepare('INSERT INTO ai_analysis_batches(task_id,batch_index,data) VALUES(?,?,?)').run(row.id, batch.index, JSON.stringify(data))
        const cover = db.prepare('INSERT INTO ai_analysis_coverage(task_id,message_id) VALUES(?,?) ON CONFLICT DO NOTHING')
        for (const messageId of batch.messageIds) cover.run(row.id, id(messageId))
        if (batch.requestId) insertUsage({ ownerKind: 'analysis', ownerId: taskId, requestId: batch.requestId, usage: batch.usage })
        db.prepare('UPDATE ai_analysis_tasks SET event_sequence=event_sequence+1 WHERE id=?').run(row.id)
      })())
      return repository.getAnalysis(taskId)
    },
    async completeAnalysis(taskId: string, report: AiReport): Promise<AnalysisTask> {
      await write(() => db.transaction(() => {
        const row = analysisRow(taskId); if (!activeStates.has(row.state)) return; assertCurrent(row)
        const allowed = new Set(messages(String(row.conversation_id), row.snapshot_max_id).filter(analyzable).map(message => message.id)); validateReport(report, allowed)
        const covered = db.prepare('SELECT count(*) AS n FROM ai_analysis_coverage WHERE task_id=?').get(row.id) as { n: bigint }
        if (covered.n !== row.total_messages) fail('ANALYSIS_INCOMPLETE', '请继续分析剩余消息。')
        db.prepare('INSERT INTO ai_reports(task_id,data) VALUES(?,?)').run(row.id, JSON.stringify(report))
        db.prepare("UPDATE ai_analysis_tasks SET state='completed',error=NULL,event_sequence=event_sequence+1 WHERE id=?").run(row.id)
      })())
      return repository.getAnalysis(taskId)
    },
    async resumeAnalysis(taskId: string): Promise<AnalysisTask> {
      await write(() => {
        const row = analysisRow(taskId); assertCurrent(row)
        if (!['stopped', 'failed', 'interrupted'].includes(row.state)) fail('INVALID_STATE')
        if (enabledModel(row.model_id).version !== Number(row.model_version)) fail('MODEL_CHANGED', '模型配置已更新，请重新准备分析。')
        if (db.prepare("SELECT 1 FROM ai_analysis_tasks WHERE conversation_id=? AND state IN ('queued','running','summarizing')").get(row.conversation_id)) fail('ANALYSIS_BUSY')
        db.prepare("UPDATE ai_analysis_tasks SET state='queued',error=NULL,event_sequence=event_sequence+1 WHERE id=?").run(row.id)
      })
      return repository.getAnalysis(taskId)
    },
    async openThread(conversationId: string): Promise<AiThread> {
      conversation(conversationId)
      const threadId = await write(() => { db.prepare('INSERT INTO ai_threads(conversation_id) VALUES(?) ON CONFLICT(conversation_id) DO NOTHING').run(id(conversationId)); return String((db.prepare('SELECT id FROM ai_threads WHERE conversation_id=?').get(id(conversationId)) as { id: bigint }).id) })
      return repository.getThread(threadId)
    },
    getThread(threadId: string): AiThread { const conversationId = threadConversation(threadId); return { id: threadId, conversationId, turns: (reader.prepare('SELECT * FROM ai_turns WHERE thread_id=? ORDER BY id').all(id(threadId)) as TurnRow[]).map(turnView) } },
    async createTurn(input: NewTurn): Promise<AiTurn> {
      fields(input, ['threadId', 'requestId', 'prompt', 'referenceIds', 'modelId', 'skillId'])
      if (!key(input.requestId) || !text(input.prompt, 65536) || !input.prompt.trim()) fail('INVALID_ARGUMENT')
      const turnId = await write(() => db.transaction(() => {
        const conversationId = threadConversation(input.threadId)
        const existing = db.prepare('SELECT * FROM ai_turns WHERE thread_id=? AND request_id=?').get(id(input.threadId), input.requestId) as TurnRow | undefined
        if (existing) {
          const skill = existing.skill ? parse<RegisteredSkill>(existing.skill) : null
          if (existing.prompt !== input.prompt || existing.reference_ids !== JSON.stringify(input.referenceIds) || existing.model_id !== input.modelId || skill?.id !== input.skillId) fail('REQUEST_CONFLICT')
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
        if (db.prepare("SELECT 1 FROM ai_turns WHERE thread_id=? AND state IN ('queued','running','summarizing')").get(id(input.threadId))) fail('TURN_BUSY', '请等待回答完成或先停止回答。')
        return String(db.prepare("INSERT INTO ai_turns(thread_id,request_id,prompt,reference_ids,model_id,model_version,skill,self_fingerprint,state) VALUES(?,?,?,?,?,?,?,?,'queued')").run(id(input.threadId), input.requestId, input.prompt, JSON.stringify(input.referenceIds), model.id, model.version, skill ? JSON.stringify(skill) : null, self.fingerprint).lastInsertRowid)
      })())
      return turnView(turnRow(turnId))
    },
    turnContext(turnId: string): TurnContext {
      const row = turnRow(turnId), conversationId = threadConversation(String(row.thread_id)), self = identity(conversationId)
      if (row.self_fingerprint !== self.fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新提问。')
      const previous = reader.prepare("SELECT * FROM ai_turns WHERE thread_id=? AND id<? AND state='completed' AND self_fingerprint=? ORDER BY id").all(row.thread_id, row.id, self.fingerprint) as TurnRow[]
      const history: TurnContext['history'] = []
      for (const turn of previous) {
        const references = sources(conversationId, parse<string[]>(turn.reference_ids))
        history.push({ role: 'user', text: references.length ? JSON.stringify({ question: turn.prompt, references }) : turn.prompt }, { role: 'assistant', text: turn.text })
      }
      const latest = previous.at(-1), skill = row.skill ? parse<RegisteredSkill>(row.skill) : null
      const sameCheckpointContext = latest?.model_id === row.model_id && latest?.model_version === row.model_version && latest?.skill === row.skill
      const profile = repository.listAnalyses(conversationId).find(task => task.state === 'completed' && task.valid && task.report)?.report ?? null
      return { turn: turnView(row), threadId: String(row.thread_id), conversationId, model: modelSecret(row.model_id, Number(row.model_version)).model, selfFingerprint: self.fingerprint, references: sources(conversationId, parse<string[]>(row.reference_ids)), history, profile, skill, checkpoint: sameCheckpointContext ? latest!.checkpoint : null }
    },
    async saveTurn(turnId: string, patch: TurnPatch): Promise<AiTurn> {
      patchState(patch, true)
      if (patch.text !== undefined && (typeof patch.text !== 'string' || patch.text.length > 8 * 1024 ** 2)) fail('INVALID_ARGUMENT')
      await write(() => {
        const row = turnRow(turnId); if (!activeStates.has(row.state)) return
        if ((patch.text !== undefined || patch.state === 'completed') && identity(threadConversation(String(row.thread_id))).fingerprint !== row.self_fingerprint) fail('IDENTITY_CHANGED', '本人身份已更新，请重新提问。')
        db.prepare('UPDATE ai_turns SET state=?,text=?,error=?,checkpoint=?,event_sequence=event_sequence+1 WHERE id=?').run(patch.state ?? row.state, patch.text ?? row.text, Object.hasOwn(patch, 'error') ? patch.error ?? null : row.error, patch.checkpoint === undefined ? row.checkpoint : patch.checkpoint, row.id)
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
        if (enabledModel(row.model_id).version !== Number(row.model_version)) fail('MODEL_CHANGED', '模型配置已更新，请重新提问。')
        if (db.prepare('SELECT 1 FROM ai_turns WHERE thread_id=? AND id>? LIMIT 1').get(row.thread_id, row.id)) fail('INVALID_STATE', '请重新发送提问。')
        sources(conversationId, parse<string[]>(row.reference_ids))
        db.prepare("UPDATE ai_turns SET state='queued',text='',error=NULL,checkpoint=NULL,attempt=attempt+1,event_sequence=event_sequence+1 WHERE id=?").run(row.id)
      })
      return turnView(turnRow(turnId))
    },
    async recordUsage(record: UsageRecord): Promise<AnalysisTask | AiTurn> {
      await write(() => db.transaction(() => { insertUsage(record); db.prepare(`UPDATE ${record.ownerKind === 'analysis' ? 'ai_analysis_tasks' : 'ai_turns'} SET event_sequence=event_sequence+1 WHERE id=?`).run(id(record.ownerId)) })())
      return record.ownerKind === 'analysis' ? repository.getAnalysis(record.ownerId) : turnView(turnRow(record.ownerId))
    },
    async recover(): Promise<void> {
      await write(() => db.transaction(() => {
        db.prepare("UPDATE ai_analysis_tasks SET state='interrupted',event_sequence=event_sequence+1 WHERE state IN ('queued','running','summarizing')").run()
        db.prepare("UPDATE ai_turns SET state='interrupted',event_sequence=event_sequence+1 WHERE state IN ('queued','running','summarizing')").run()
      })())
    },
  }
  return repository
}
export type AiRepository = ReturnType<typeof createAiRepository>
