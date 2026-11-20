import { afterEach, expect, test, vi } from 'vitest'
import { createAiRepository } from '../../electron/data/ai/repository'
import { ANALYSIS_PROMPT_VERSION } from '../../electron/data/ai/prompt-version'
import { openStore } from '../../electron/data/db/open'
import { purgeConversation } from '../../electron/data/db/purge'
import { schemaVersion } from '../../electron/data/db/schema'
import { validateAiCall, validateAiResult } from '../../src/shared/ai-validation'
import type { InsightReport } from '../../src/shared/conversation-insights'
import { removeInsightSchemaForMigrationTest, temporaryStore, useLegacyAnalysisFixture } from './helpers'

const cleanup: (() => void)[] = []
afterEach(() => { for (const operation of cleanup.splice(0).reverse()) operation() })

const october = { kind: 'dates', startDate: '2026-10-01', endDate: '2026-10-31', timezone: 'Asia/Shanghai' } as const
const start = Date.parse('2026-10-01T00:00:00+08:00')
const end = Date.parse('2026-10-31T23:59:59.999+08:00')
const next = Date.parse('2026-11-01T00:00:00+08:00')

async function setup() {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanup.push(() => { store.close(); temp.cleanup() })
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'小林','direct',0),(2,'小周','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one'),(2,2,'example','two');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人'),(2,1,1,'other','小林'),(3,2,2,'me','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user'),(2,3,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES
      (1,1,1,'member','本人','text','我们几点开始？',0,${start}),
      (2,1,2,'member','小林','text','十一月再联系。',1,${next}),
      (3,1,2,'member','小林','text','时间待定。',2,NULL),
      (4,1,2,'member','小林','reply','今天九点。',3,${end}),
      (5,2,3,'member','本人','text','另一会话',0,${start});
    INSERT INTO message_keys VALUES(1,'source','first',1);
    INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state) VALUES(4,1,1,'first','source','resolved')`)
  const repository = createAiRepository(store, async operation => operation())
  await repository.saveModel({ id: 'example', label: '示例服务', model: 'example-model', baseUrl: 'http://127.0.0.1:1234/v1', contextWindow: 4096, maxTokens: 512, enabled: true }, 'encrypted-example')
  return { store, repository, temp }
}

test.each([
  {
    label: '仅第一次返回读取零值，写入均为零',
    caches: [{ cacheReadTokens: 0, cacheWriteTokens: 0 }, { cacheWriteTokens: 0 }],
    expected: { cacheReadTokens: 0, cacheReadTokensIncomplete: true, cacheWriteTokens: 0 },
  },
  {
    label: '读取完整，写入只有第一次返回非零值',
    caches: [{ cacheReadTokens: 3, cacheWriteTokens: 5 }, { cacheReadTokens: 4 }],
    expected: { cacheReadTokens: 7, cacheWriteTokens: 5, cacheWriteTokensIncomplete: true },
  },
  {
    label: '每次都返回读取和写入零值',
    caches: [{ cacheReadTokens: 0, cacheWriteTokens: 0 }, { cacheReadTokens: 0, cacheWriteTokens: 0 }],
    expected: { cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  {
    label: '历史记录未保存缓存用量',
    caches: [{}, {}],
    expected: {},
  },
])('洞察用量区分缓存字段的报告完整性：$label', async ({ caches, expected }) => {
  const { repository } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })
  const task = await repository.confirmAnalysis({ token: preparation.token, requestId: 'cache-usage' })
  for (const [index, cache] of caches.entries()) {
    await repository.recordUsage({ ownerKind: 'analysis', ownerId: task.id, requestId: String(index),
      usage: { inputTokens: 50, totalInputTokens: 60, outputTokens: 10, durationMs: 1000, ...cache } })
  }

  const snapshot = repository.getAnalysis(task.id)
  expect(snapshot.usage).toEqual({ inputTokens: 100, totalInputTokens: 120, outputTokens: 20,
    durationMs: 2000, outputTokensPerSecond: 10, ...expected })
  expect(() => validateAiResult('getAnalysis', snapshot)).not.toThrow()
})

test('取消准备释放完整快照，重复取消和迟到取消不删除已确认任务', async () => {
  const { repository, store } = await setup()
  const cancelled = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })
  expect(store.reader.prepare('SELECT insight_snapshot FROM ai_preparations WHERE token=?').get(cancelled.token)).toMatchObject({ insight_snapshot: expect.any(String) })
  await repository.discardAnalysisPreparation(cancelled.token)
  await repository.discardAnalysisPreparation(cancelled.token)
  expect(store.reader.prepare('SELECT token FROM ai_preparations WHERE token=?').get(cancelled.token)).toBeUndefined()
  await expect(repository.confirmAnalysis({ token: cancelled.token, requestId: 'cancelled' })).rejects.toHaveProperty('code', 'CONFIRMATION_EXPIRED')

  const accepted = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })
  const task = await repository.confirmAnalysis({ token: accepted.token, requestId: 'accepted' })
  await repository.discardAnalysisPreparation(accepted.token)
  expect(store.reader.prepare('SELECT insight_snapshot FROM ai_preparations WHERE token=?').get(accepted.token)).toEqual({ insight_snapshot: null })
  expect(repository.analysisContext(task.id).snapshot?.sources).toHaveLength(4)
  await expect(repository.confirmAnalysis({ token: accepted.token, requestId: 'accepted' })).resolves.toMatchObject({ id: task.id })
})

test('再次准备会清理过期快照并保留尚未过期的确认窗口', async () => {
  const { repository, store } = await setup()
  const abandoned = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, 1000)
  const stillOpen = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, abandoned.expiresAt - 1)
  const latest = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, abandoned.expiresAt)
  const tokens = store.reader.prepare('SELECT token FROM ai_preparations ORDER BY expires_at_ms').all()
  expect(tokens).toEqual([{ token: stillOpen.token }, { token: latest.token }])
  await expect(repository.confirmAnalysis({ token: stillOpen.token, requestId: 'still-open' }, abandoned.expiresAt)).resolves.toMatchObject({ totalMessages: 4 })
})

test('恢复时清理旧版遗留的过期准备快照并保留任务来源和有效准备', async () => {
  const { repository, store } = await setup()
  const before = Date.now() - 6 * 60 * 1000
  const abandoned = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, before)
  const accepted = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, before)
  const task = await repository.confirmAnalysis({ token: accepted.token, requestId: 'recover-accepted' }, before)
  // 旧版本遗留的快照可与有效准备同时存在。
  store.writer.prepare('UPDATE ai_preparations SET expires_at_ms=? WHERE token=?').run(Date.now() + 60_000, abandoned.token)
  const stillOpen = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })
  store.writer.prepare('UPDATE ai_preparations SET expires_at_ms=? WHERE token=?').run(before, abandoned.token)

  await repository.recover()
  expect(store.reader.prepare('SELECT token FROM ai_preparations WHERE token=?').get(abandoned.token)).toBeUndefined()
  expect(store.reader.prepare('SELECT token FROM ai_preparations WHERE token=?').get(stillOpen.token)).toEqual({ token: stillOpen.token })
  expect(repository.getAnalysis(task.id)).toMatchObject({ state: 'interrupted' })
  expect(repository.analysisContext(task.id).snapshot?.sources).toHaveLength(4)
  await expect(repository.confirmAnalysis({ token: accepted.token, requestId: 'recover-accepted' })).resolves.toMatchObject({ id: task.id })
})

test('日期范围包含上海时区首日零点和最后一日最后一毫秒', async () => {
  const { repository, store } = await setup()
  const input = { conversationId: '1', modelId: 'example', scope: october }
  expect(() => validateAiCall('prepareAnalysis', [input])).not.toThrow()
  const preparation = await repository.prepareAnalysis(input, 1000)
  expect(preparation).toMatchObject({ scope: october, timezone: 'Asia/Shanghai', totalMessages: 2, analyzableMessages: 2 })
  store.writer.exec(`INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms)
    VALUES(6,1,2,'member','小林','text','补导的十月记录。',4,${start + 1})`)
  const task = await repository.confirmAnalysis({ token: preparation.token, requestId: 'oct' }, 1001)
  expect(task).toMatchObject({ title: '会话洞察', scope: october, sourceStartTimeMs: start, sourceEndTimeMs: end })
  const snapshot = repository.analysisContext(task.id).snapshot!
  expect(snapshot.sources.map(source => source.messageId)).toEqual(['1', '4'])
  expect(repository.readInsightSources({ taskId: task.id, messageIds: ['4', '1'] })).toMatchObject([
    { id: '4', text: '今天九点。', sentAtMs: end, replyToMessageId: '1' },
    { id: '1', text: '我们几点开始？', sentAtMs: start, replyToMessageId: null },
  ])
  for (const messageId of ['2', '3', '5', '6']) {
    expect(() => repository.readInsightSources({ taskId: task.id, messageIds: [messageId] })).toThrow()
  }
})

test('拒绝无效日期、颠倒日期、错误时区和没有消息的日期范围', async () => {
  const { repository } = await setup()
  const base = { conversationId: '1', modelId: 'example' }
  for (const scope of [{ ...october, startDate: '2026-02-30' }, { ...october, startDate: '2026-11-01' }, { ...october, timezone: 'Asia/Nowhere' }]) {
    expect(() => validateAiCall('prepareAnalysis', [{ ...base, scope }])).toThrow()
  }
  await expect(repository.prepareAnalysis({ ...base, scope: { ...october, startDate: '2026-09-01', endDate: '2026-09-02' } })).rejects.toHaveProperty('code', 'EMPTY_INSIGHT_SCOPE')
})

test('范围预览在未确认本人时也能返回实际消息数量', async () => {
  const { repository, store } = await setup()
  store.writer.exec('DELETE FROM self_confirmations WHERE conversation_id=1')
  const input = { conversationId: '1', scope: october }
  expect(() => validateAiCall('previewInsightScope', [input])).not.toThrow()
  expect(repository.previewInsightScope(input)).toEqual({
    scope: october, timezone: 'Asia/Shanghai', totalMessages: 2, analyzableMessages: 2, sourceStartTimeMs: start, sourceEndTimeMs: end,
  })
  expect(repository.previewInsightScope({ ...input, scope: { ...october, startDate: '2026-09-01', endDate: '2026-09-30' } })).toMatchObject({
    totalMessages: 0, analyzableMessages: 0, sourceStartTimeMs: null, sourceEndTimeMs: null,
  })
})

test('省略范围时包含无日期消息，改名仅更新显示名和事件版本', async () => {
  const { repository } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })
  const before = await repository.confirmAnalysis({ token: preparation.token, requestId: 'all' })
  expect(before).toMatchObject({ title: '会话洞察', scope: { kind: 'all' }, totalMessages: 4, timezone: preparation.timezone })
  expect(repository.listAnalyses()).toEqual([before])
  expect(() => validateAiResult('listAnalyses', [before])).not.toThrow()
  const renamed = await repository.renameAnalysis({ taskId: before.id, title: ' 那次合作 ' })
  expect(renamed.title).toBe('那次合作')
  expect(renamed.scope).toEqual(before.scope)
  expect(renamed.sourceEndTimeMs).toBe(before.sourceEndTimeMs)
  expect(renamed.eventSequence).toBe(before.eventSequence + 1)
  expect(renamed.id).toBe(before.id)
  expect(() => validateAiCall('renameAnalysis', [{ taskId: before.id, title: '😀'.repeat(80) }])).not.toThrow()
  await expect(repository.renameAnalysis({ taskId: before.id, title: '😀'.repeat(81) })).rejects.toHaveProperty('code', 'INVALID_ARGUMENT')
  expect(() => validateAiCall('renameAnalysis', [{ taskId: before.id, title: '  ' }])).toThrow()
})

test('原文指纹拦截正文、身份、时间、回复及缺失原文', async () => {
  const { repository, store } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example', scope: october })
  const task = await repository.confirmAnalysis({ token: preparation.token, requestId: 'revision' })
  const read = () => repository.readInsightSources({ taskId: task.id, messageIds: ['4'] })
  expect(read()[0].revision).toMatch(/^[a-f0-9]{64}$/)
  const mutations = [
    ["UPDATE messages SET text='其他文字' WHERE id=4", "UPDATE messages SET text='今天九点。' WHERE id=4"],
    ['UPDATE messages SET member_id=1 WHERE id=4', 'UPDATE messages SET member_id=2 WHERE id=4'],
    [`UPDATE messages SET sent_at_ms=${end - 1} WHERE id=4`, `UPDATE messages SET sent_at_ms=${end} WHERE id=4`],
    ["UPDATE message_replies SET target_message_id=NULL,state='unresolved' WHERE message_id=4", "UPDATE message_replies SET target_message_id=1,state='resolved' WHERE message_id=4"],
  ]
  for (const [mutate, restore] of mutations) {
    store.writer.exec(mutate)
    expect(read).toThrow()
    store.writer.exec(restore)
  }
  store.writer.exec('DELETE FROM messages WHERE id=4')
  expect(read).toThrow()
})

test('同名的本人和对方提供独立成员编号以使用正确的匿名化名称', async () => {
  const { repository, store } = await setup()
  store.writer.exec("UPDATE memberships SET display_name='小林' WHERE id=1; UPDATE messages SET sender_name='小林' WHERE id=1")
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example', scope: october })
  const task = await repository.confirmAnalysis({ token: preparation.token, requestId: 'same-name' })
  expect(repository.readInsightSources({ taskId: task.id, messageIds: ['1', '4'] })).toMatchObject([
    { id: '1', memberId: '1', senderName: '小林', isSelf: true },
    { id: '4', memberId: '2', senderName: '小林', isSelf: false },
  ])
})

test('断点及已完整读取的消息一起保存，恢复后延续覆盖率和累计耗时', async () => {
  const { repository, temp, store } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example', scope: october })
  const task = await repository.confirmAnalysis({ token: preparation.token, requestId: 'checkpoint' })
  await expect(repository.saveInsightCheckpoint(task.id, 'out-of-scope', ['1', '2'], 1200)).rejects.toHaveProperty('code', 'INVALID_INSIGHT_SOURCE')
  expect(repository.analysisContext(task.id)).toMatchObject({ checkpoint: null, task: { analyzedMessages: 0 } })
  await repository.saveInsightCheckpoint(task.id, 'partial', ['1'], 1600)
  await repository.saveAnalysis(task.id, { state: 'stopped' })
  store.close()
  const reopened = openStore(temp.path)
  cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, async operation => operation())
  expect(restored.analysisContext(task.id)).toMatchObject({ checkpoint: 'partial', task: { state: 'stopped', analyzedMessages: 1, elapsedMs: 1600 } })
  await restored.resumeAnalysis(task.id)
  await expect(restored.saveInsightCheckpoint(task.id, 'regressed', ['4'], 2000)).rejects.toHaveProperty('code', 'INVALID_INSIGHT_CHECKPOINT')
  await restored.saveInsightCheckpoint(task.id, 'complete', ['1', '4'], 2400)
  expect(restored.analysisContext(task.id)).toMatchObject({ checkpoint: 'complete', task: { analyzedMessages: 2, elapsedMs: 2400 } })
})

test('版本 8 的已保存报告和分析断点升级后仍可读取和续跑', async () => {
  const { store, repository, temp } = await setup()
  useLegacyAnalysisFixture(store)
  async function begin(requestId: string) {
    const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })
    return repository.confirmAnalysis({ token: preparation.token, requestId })
  }
  const completed = await begin('v8-report')
  const oldReport = {
    format: 'memory-v4' as const, events: [], relationship: '保留旧正文。',
    dimensions: { EI: null, SN: null, TF: null, JP: null },
    eventVotes: { EI: [0, 0], SN: [0, 0], TF: [0, 0], JP: [0, 0] },
    dimensionExplanations: { EI: null, SN: null, TF: null, JP: null },
  } satisfies import('../../src/shared/memory').SavedReport
  await repository.commitBatch(completed.id, { index: 0, messageIds: ['1', '2', '3', '4'], report: { events: [] }, usage: {} })
  await repository.completeAnalysis(completed.id, oldReport)
  const interrupted = await begin('v8-interrupted')
  await repository.commitBatch(interrupted.id, { index: 0, messageIds: ['1'], report: { events: [] }, usage: {} })
  await repository.saveAnalysis(interrupted.id, { state: 'interrupted', checkpoint: '历史断点' })
  const historicalPrompts = { memorySource: '版本 8 的阅读指令' }
  store.writer.prepare('UPDATE ai_analysis_tasks SET prompt_snapshot=? WHERE id=?').run(JSON.stringify(historicalPrompts), BigInt(interrupted.id))
  removeInsightSchemaForMigrationTest(store)
  store.close()

  const reopened = openStore(temp.path)
  cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, async operation => operation())
  expect(reopened.reader.pragma('user_version', { simple: true })).toBe(BigInt(schemaVersion))
  expect(restored.getReport(completed.id)).toEqual(oldReport)
  expect(restored.getAnalysis(completed.id)).not.toHaveProperty('scope')
  expect(await restored.readInsightCitation({ taskId: completed.id, citationId: 'old', fragmentIndex: 0 })).toEqual({ status: 'unavailable' })
  expect((await restored.resumeAnalysis(interrupted.id)).state).toBe('queued')
  expect(restored.analysisContext(interrupted.id)).toMatchObject({
    systemPrompts: historicalPrompts, checkpoint: '历史断点', promptVersion: ANALYSIS_PROMPT_VERSION,
    batches: [{ index: 0, messageIds: ['1'] }],
  })
  expect(reopened.reader.pragma('foreign_key_check')).toEqual([])
})

test('报告拒绝未完整覆盖、跨会话或版本不符的来源', async () => {
  const { repository } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example', scope: october })
  const task = await repository.confirmAnalysis({ token: preparation.token, requestId: 'report-validation' })
  const source = repository.readInsightSources({ taskId: task.id, messageIds: ['1'] })[0]
  const report: InsightReport = {
    format: 'conversation-insights-v1',
    aboutYou: [{ content: [{ text: '我先询问几点开始。', citationId: 'time' }] }], relationship: [],
    citations: [{ id: 'time', conversationId: '1', fragments: [{ sources: [{ messageId: '1', revision: source.revision }] }] }], limitations: [],
  }
  await expect(repository.completeAnalysis(task.id, report)).rejects.toHaveProperty('code', 'ANALYSIS_INCOMPLETE')
  await repository.saveInsightCheckpoint(task.id, 'complete', ['1', '4'], 2500)
  await expect(repository.completeAnalysis(task.id, { ...report, citations: [{ ...report.citations[0], conversationId: '2' }] }))
    .rejects.toHaveProperty('code', 'INVALID_INSIGHT_CITATION')
  for (const ref of [{ messageId: '2', revision: source.revision }, { messageId: '1', revision: '0'.repeat(64) }]) {
    const citations = [{ ...report.citations[0], fragments: [{ sources: [ref] }] }]
    await expect(repository.completeAnalysis(task.id, { ...report, citations })).rejects.toHaveProperty('code', 'INVALID_INSIGHT_CITATION')
  }
  expect(repository.getAnalysis(task.id)).not.toHaveProperty('insightContentRevision')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(4000)
  try {
    const completed = await repository.completeAnalysis(task.id, report, 1000)
    expect(completed).toMatchObject({ state: 'completed', elapsedMs: 5500,
      insightContentRevision: expect.stringMatching(/^[a-f0-9]{64}$/), report })
    expect(await repository.completeAnalysis(task.id, report, 1000)).toEqual(completed)
  } finally {
    clock.mockRestore()
  }
})

test('回复补全或重新确认本人后，旧报告仍能定位原文，未完任务保持原来的输入版本', async () => {
  const { repository, store } = await setup()
  store.writer.exec("UPDATE message_replies SET target_message_id=NULL,original_id=NULL,id_namespace=NULL,state='unresolved' WHERE message_id=4")
  async function begin(requestId: string) {
    const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example', scope: october })
    return repository.confirmAnalysis({ token: preparation.token, requestId })
  }
  const task = await begin('completed-with-unresolved-reply')
  const source = repository.readInsightSources({ taskId: task.id, messageIds: ['4'] })[0]
  const report: InsightReport = {
    format: 'conversation-insights-v1', relationship: [{ content: [{ text: '对方说今天九点。', citationId: 'reply' }] }],
    aboutYou: [], limitations: [],
    citations: [{ id: 'reply', conversationId: '1', fragments: [{ sources: [{ messageId: source.id, revision: source.revision }] }] }],
  }
  expect(repository.analysisContext(task.id).snapshot?.sources[0]).toEqual({ messageId: '1', revision: expect.any(String) })
  await repository.saveInsightCheckpoint(task.id, 'done', ['1', '4'])
  await repository.completeAnalysis(task.id, report)

  const inProgress = await begin('stopped-before-resolution')
  await repository.saveAnalysis(inProgress.id, { state: 'stopped' })
  const read = () => repository.readInsightCitation({ taskId: task.id, citationId: 'reply', fragmentIndex: 0 })
  store.writer.exec("UPDATE message_replies SET target_message_id=1,original_id='first',id_namespace='source',state='resolved' WHERE message_id=4")
  expect(await read()).toMatchObject({ status: 'available', highlightIds: ['4'] })
  expect(() => repository.readInsightSources({ taskId: inProgress.id, messageIds: ['4'] })).toThrow()
  store.writer.exec("UPDATE self_confirmations SET status='revoked' WHERE conversation_id=1; INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,2,'confirmed','user')")
  expect(repository.getAnalysis(task.id).valid).toBe(false)
  expect(await read()).toMatchObject({ status: 'available', highlightIds: ['4'] })
  await expect(repository.resumeAnalysis(inProgress.id)).rejects.toHaveProperty('code', 'IDENTITY_CHANGED')
  store.writer.exec("UPDATE messages SET text='异常修改的正文' WHERE id=4")
  expect(await read()).toEqual({ status: 'expired' })
})

test('保存后引用只高亮实际证据，报告删除和整会话删除撤回各自来源', async () => {
  const { repository, store } = await setup()
  async function begin(conversationId: string, requestId: string) {
    const preparation = await repository.prepareAnalysis({ conversationId, modelId: 'example' })
    return repository.confirmAnalysis({ token: preparation.token, requestId })
  }
  function manuscript(taskId: string, conversationId: string, ids: string[]) {
    const source = repository.readInsightSources({ taskId, messageIds: ids })
    return {
      format: 'conversation-insights-v1' as const,
      aboutYou: [{ content: [{ text: '我先询问时间。', citationId: 'time' }] }],
      relationship: [], limitations: [],
      judgments: [{ dimension: 'JP' as const, direction: 'J' as const, text: '我先询问时间。', supportingSources: [{ messageId: source[0].id, revision: source[0].revision }], counterexampleSources: [], alternativeExplanations: [], limitations: [] }],
      citations: [{ id: 'time', conversationId, fragments: [{ sources: source.map(message => ({ messageId: message.id, revision: message.revision })) }] }],
    }
  }
  async function complete(taskId: string, conversationId: string, ids: string[]) {
    const snapshot = repository.analysisContext(taskId).snapshot!
    const report = manuscript(taskId, conversationId, ids)
    await repository.saveInsightCheckpoint(taskId, 'checkpoint', snapshot.sources.map(source => source.messageId))
    return repository.completeAnalysis(taskId, report)
  }
  const first = await begin('1', 'first')
  const completedFirst = await complete(first.id, '1', ['1', '2'])
  const second = await begin('1', 'second')
  await complete(second.id, '1', ['1', '4'])
  const other = await begin('2', 'other')
  await complete(other.id, '2', ['5'])
  const read = () => repository.readInsightCitation({ taskId: first.id, citationId: 'time', fragmentIndex: 0 })
  const located = await read()
  expect(located).toMatchObject({ status: 'available', highlightIds: ['1', '2'], page: { items: [{ id: '1' }, { id: '4' }, { id: '2' }, { id: '3' }] } })
  expect(() => validateAiResult('readInsightCitation', located)).not.toThrow()
  expect(() => validateAiResult('readInsightCitation', { ...located, highlightIds: ['1', '4'] })).toThrow()
  const renamed = await repository.renameAnalysis({ taskId: first.id, title: '那次合作' })
  await repository.renameAnalysis({ taskId: second.id, title: '那次合作' })
  expect(renamed).toMatchObject({ id: first.id, title: '那次合作', insightContentRevision: completedFirst.insightContentRevision, report: completedFirst.report })
  expect(await repository.readInsightCitation({ taskId: first.id, citationId: 'missing', fragmentIndex: 0 })).toEqual({ status: 'unavailable' })
  store.writer.exec(`INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms)
    VALUES(6,1,2,'member','小林','text','这条消息是后来导入的。',4,${start + 1})`)
  expect(await read()).toMatchObject({ status: 'available', highlightIds: ['1', '2'] })
  store.writer.exec('ALTER TABLE message_replies RENAME TO temporarily_unavailable')
  await expect(read()).rejects.toThrow()
  store.writer.exec('ALTER TABLE temporarily_unavailable RENAME TO message_replies')
  expect(await read()).toMatchObject({ status: 'available', highlightIds: ['1', '2'] })
  store.writer.exec("UPDATE messages SET text='测试异常' WHERE id=2")
  expect(await read()).toEqual({ status: 'expired' })
  store.writer.exec("UPDATE messages SET text='十一月再联系。' WHERE id=2")
  expect(repository.listAnalyses().map(task => task.id)).toEqual([other.id, second.id, first.id])
  await repository.deleteAnalysis(first.id)
  expect(await read()).toEqual({ status: 'unavailable' })
  expect(store.reader.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=1').get()).toEqual({ n: 5n })
  purgeConversation(store, '1')
  expect(repository.listAnalyses().map(task => task.id)).toEqual([other.id])
  expect(store.reader.prepare('SELECT task_id FROM ai_reports').all()).toEqual([{ task_id: BigInt(other.id) }])
  expect(store.reader.prepare('SELECT task_id FROM ai_insight_snapshots').all()).toEqual([{ task_id: BigInt(other.id) }])
  expect(store.reader.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=1').get()).toEqual({ n: 0n })
  expect(store.reader.pragma('foreign_key_check')).toEqual([])
})
