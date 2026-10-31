import { afterEach, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { openStore, type Store } from '../../electron/data/db/open'
import { schema, selfOptOutSchema, importStateSchema } from '../../electron/data/db/schema'
import { createAiRepository } from '../../electron/data/ai/repository'
import { temporaryStore } from './helpers'
import type { AiReport } from '../../src/shared/ai-contract'
import { createDataService } from '../../electron/data/service'
import { createDataDispatcher } from '../../electron/data/dispatch'
import { validateAiCall, validateAiResult } from '../../src/shared/ai-validation'
import { aiSchema } from '../../electron/data/ai/schema'
import { purgeConversation } from '../../electron/data/db/purge'

const cleanup: (() => void)[] = []
afterEach(() => { for (const operation of cleanup.splice(0).reverse()) operation() })
async function setup() {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanup.push(() => { store.close(); temp.cleanup() })
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'示例甲','direct',0),(2,'示例乙','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one'),(2,2,'example','two');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人'),(2,1,1,'other','对方'),(3,2,2,'other','另一人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','想听听你的想法',0),(2,1,2,'member','对方','text','我需要一些时间',1),(3,2,3,'member','另一人','text','其他会话的原文',0)`)
  let queue: Promise<unknown> = Promise.resolve()
  const write = <T,>(operation: () => T | Promise<T>): Promise<T> => { const next = queue.then(operation); queue = next.catch(() => {}); return next }
  const repository = createAiRepository(store, write)
  const model = await repository.saveModel({ id: 'example', label: '示例服务', model: 'example-model', baseUrl: 'http://127.0.0.1:1234/v1', contextWindow: 4096, maxTokens: 512, enabled: true }, 'encrypted-example')
  return { store, repository, model, path: temp.path }
}
const report: AiReport = { summary: '示例观察', observations: [{ text: '尝试了解对方', evidenceMessageIds: ['1'], limitations: '仅限本段记录' }], limitations: '材料有限' }

test('turn identity preserves its generating version after rename, disable and restart without exposing credentials', async () => {
  const { repository, store, model, path } = await setup()
  const thread = await repository.openThread('1')
  const turn = await repository.createTurn({ threadId: thread.id, requestId: 'identity', prompt: '问题', referenceIds: [], modelId: model.id })
  await repository.saveTurn(turn.id, { state: 'completed', text: '回答' })
  await repository.saveModel({ ...model, label: '新名称', model: 'changed-model', enabled: false })
  store.close()
  const reopened = openStore(path); cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, async operation => operation())
  const value = restored.getThread(thread.id)
  expect(value.turns[0]).toMatchObject({ modelIdentity: { id: 'example', version: 1, label: '示例服务', model: 'example-model' } })
  expect(Object.keys(value.turns[0].modelIdentity!).sort()).toEqual(['id', 'label', 'model', 'version'])
  expect(() => validateAiResult('getThread', value)).not.toThrow()
  reopened.writer.prepare('DELETE FROM ai_model_versions WHERE model_id=? AND version=?').run(model.id, 1)
  expect(restored.getThread(thread.id).turns[0]).toMatchObject({ modelId: 'example', text: '回答' })
  expect(restored.getThread(thread.id).turns[0].modelIdentity).toBeUndefined()
})
async function task(repository: Awaited<ReturnType<typeof setup>>['repository'], requestId = 'confirm') {
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, 1000)
  return repository.confirmAnalysis({ token: preparation.token, requestId }, 1001)
}
function changeSelf(store: Store) { store.writer.exec("UPDATE self_confirmations SET status='revoked'; INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,2,'confirmed','user')") }

test('independent threads keep their own history, metadata and conversation scope after restart', async () => {
  const { store, repository, path } = await setup()
  expect(repository.listThreads('1')).toEqual([])
  const first = await repository.createThread('1'), second = await repository.createThread('1'), other = await repository.createThread('2')
  expect(new Set([first.id, second.id, other.id]).size).toBe(3)
  const turn = await repository.createTurn({ threadId: first.id, requestId: 'first', prompt: '  我怎样\n 表达关心？  ', referenceIds: ['1'], modelId: 'example' })
  await repository.saveTurn(turn.id, { state: 'completed', text: '第一段回答', checkpoint: 'first-checkpoint' })
  const secondTurn = await repository.createTurn({ threadId: second.id, requestId: 'first', prompt: '另一段独立提问', referenceIds: ['2'], modelId: 'example' })
  expect(repository.turnContext(secondTurn.id)).toMatchObject({ history: [], checkpoint: null, conversationId: '1' })
  expect(repository.listThreads('1').map(thread => thread.id)).toEqual([second.id, first.id])
  expect(repository.listThreads('2').map(thread => thread.id)).toEqual([other.id])
  expect(repository.getThread(first.id)).toMatchObject({ title: '我怎样 表达关心？', createdAtMs: expect.any(Number), updatedAtMs: expect.any(Number), turns: [{ id: turn.id, text: '第一段回答' }] })
  await expect(repository.createTurn({ threadId: other.id, requestId: 'bad', prompt: '跨会话引用', referenceIds: ['1'], modelId: 'example' })).rejects.toHaveProperty('code', 'INVALID_REFERENCE')
  store.close()
  const reopened = openStore(path)
  cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, async operation => operation())
  expect(restored.getThread(first.id).turns[0].text).toBe('第一段回答')
  expect(restored.listThreads('1')).toHaveLength(2)
  expect((await restored.openThread('1')).id).toBe(second.id)
  expect(() => validateAiResult('listThreads', restored.listThreads('1'))).not.toThrow()
  expect(() => validateAiResult('createThread', restored.getThread(first.id))).not.toThrow()
})

test('thread titles remain the first prompt and the compatibility opener creates only one initial thread', async () => {
  const { repository } = await setup()
  const opened = await Promise.all([repository.openThread('1'), repository.openThread('1')])
  expect(opened[0].id).toBe(opened[1].id)
  const turn = await repository.createTurn({ threadId: opened[0].id, requestId: 'long', prompt: '😀'.repeat(45), referenceIds: [], modelId: 'example' })
  expect(repository.getThread(opened[0].id).title).toBe('😀'.repeat(40) + '…')
  await repository.saveTurn(turn.id, { state: 'completed', text: '完成' })
  await repository.createTurn({ threadId: opened[0].id, requestId: 'next', prompt: '后续问题', referenceIds: [], modelId: 'example' })
  expect(repository.getThread(opened[0].id).title).toBe('😀'.repeat(40) + '…')
  expect(() => repository.listThreads('999')).toThrow()
  await expect(repository.createThread('999')).rejects.toThrow()
})

test('schema four thread migration preserves original ids, turns, usage and deleted-id high water mark', async () => {
  const temp = temporaryStore(), old = new Database(temp.path)
  cleanup.push(() => temp.cleanup())
  old.exec(schema); old.exec(selfOptOutSchema); old.exec(importStateSchema); old.exec(aiSchema)
  old.exec(`PRAGMA user_version=4;
    INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'旧会话','direct',0);
    INSERT INTO ai_models VALUES('example',1,'{}',NULL);
    INSERT INTO ai_threads(id,conversation_id) VALUES(7,1);
    INSERT INTO ai_turns(id,thread_id,request_id,prompt,reference_ids,model_id,model_version,self_fingerprint,text,state) VALUES(11,7,'old','旧的第一条提问','[]','example',1,'old','旧回答','completed');
    INSERT INTO ai_request_usage VALUES('turn',11,'old','{"inputTokens":3,"outputTokens":4}');
    UPDATE sqlite_sequence SET seq=90 WHERE name='ai_threads'`)
  old.close()
  const store = openStore(temp.path); cleanup.push(() => store.close())
  const repository = createAiRepository(store, async operation => operation())
  expect(repository.getThread('7')).toMatchObject({ id: '7', conversationId: '1', title: '旧的第一条提问', createdAtMs: 0, updatedAtMs: 0, turns: [{ id: '11', text: '旧回答', usage: { inputTokens: 3, outputTokens: 4 } }] })
  expect(BigInt((await repository.createThread('1')).id)).toBeGreaterThan(90n)
  expect(repository.listThreads('1')).toHaveLength(2)
  expect(store.writer.pragma('foreign_key_check')).toEqual([])
  expect(store.writer.pragma('foreign_keys', { simple: true })).toBe(1n)
})

test('deleting an imported conversation removes every AI thread and preserves other conversations', async () => {
  const { repository, store } = await setup()
  const first = await repository.createThread('1'), second = await repository.createThread('1'), other = await repository.createThread('2')
  for (const thread of [first, second, other]) {
    const turn = await repository.createTurn({ threadId: thread.id, requestId: 'one', prompt: '示例问题', referenceIds: [], modelId: 'example' })
    await repository.recordUsage({ ownerKind: 'turn', ownerId: turn.id, requestId: 'one', usage: { outputTokens: 5 } })
  }
  purgeConversation(store, '1')
  expect(store.reader.prepare('SELECT id FROM ai_threads').all()).toEqual([{ id: BigInt(other.id) }])
  expect(repository.getThread(other.id).turns).toHaveLength(1)
  expect(store.reader.prepare('SELECT count(*) AS n FROM ai_request_usage').get()).toEqual({ n: 1n })
  expect(store.writer.pragma('foreign_key_check')).toEqual([])
})

test('unknown model capacity stays unset across validation, storage and version snapshots', async () => {
  const { repository, model } = await setup()
  const input = { id: model.id, label: model.label, model: model.model, baseUrl: model.baseUrl, enabled: true, contextWindow: null, maxTokens: null, maxInputTokens: 16000 }
  expect(() => validateAiCall('saveModel', [input])).not.toThrow()
  const saved = await repository.saveModel(input as never)
  expect(saved).toMatchObject({ contextWindow: null, maxTokens: null, maxInputTokens: 16000 })
  expect(repository.modelSecret(model.id, saved.version).model).toEqual(saved)
  expect(() => validateAiResult('listModels', [saved])).not.toThrow()
})

test('generation statistics preserve reported total input and attempt timestamps', async () => {
  const { repository } = await setup(), thread = await repository.openThread('1')
  const turn = await repository.createTurn({ threadId: thread.id, requestId: 'usage', prompt: '示例提问', referenceIds: [], modelId: 'example' })
  const usage = { inputTokens: 200, totalInputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, firstTokenMs: 9000, durationMs: 10000, startedAt: 1000, completedAt: 11000 }
  await repository.recordUsage({ ownerKind: 'turn', ownerId: turn.id, requestId: 'usage', usage })
  const result = repository.getThread(thread.id)
  expect(result.turns[0].usage).toMatchObject(usage)
  expect(() => validateAiResult('getThread', result)).not.toThrow()
})

test('analysis preparation is local and confirmations are idempotent with a fixed source snapshot', async () => {
  const { store, repository } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, 1000)
  expect(repository.listAnalyses()).toEqual([])
  store.writer.exec("INSERT INTO messages(id,conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES(4,1,'unknown','','text','后来导入',2)")
  const first = await repository.confirmAnalysis({ token: preparation.token, requestId: 'same' }, 1001)
  expect((await repository.confirmAnalysis({ token: preparation.token, requestId: 'same' }, 999999)).id).toBe(first.id)
  expect(first.totalMessages).toBe(2)
  expect(repository.analysisContext(first.id).messages.map(message => message.id)).toEqual(['1', '2'])
  await expect(repository.confirmAnalysis({ token: preparation.token, requestId: 'different' }, 1002)).rejects.toHaveProperty('code')
  const another = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, 1002)
  await expect(repository.confirmAnalysis({ token: another.token, requestId: 'second' }, 1003)).rejects.toMatchObject({ code: 'ANALYSIS_BUSY' })
})
test('changed identity, configuration and expired confirmations require preparing again', async () => {
  for (const change of ['identity', 'model', 'expiry'] as const) {
    const { store, repository, model } = await setup()
    const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, 1000)
    if (change === 'identity') changeSelf(store)
    if (change === 'model') await repository.saveModel({ ...model, label: '已更改' })
    await expect(repository.confirmAnalysis({ token: preparation.token, requestId: 'confirm' }, change === 'expiry' ? 999999 : 1001)).rejects.toHaveProperty('code')
    expect(repository.listAnalyses()).toEqual([])
  }
})
test('turns reject cross-conversation references and store original sources with idempotent user turns', async () => {
  const { repository } = await setup(), thread = await repository.openThread('1')
  await expect(repository.createTurn({ threadId: thread.id, requestId: 'bad', prompt: '解释这段', referenceIds: ['3'], modelId: 'example' })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
  const input = { threadId: thread.id, requestId: 'good', prompt: '解释这段', referenceIds: ['1'], modelId: 'example' }
  const turn = await repository.createTurn(input)
  expect((await repository.createTurn(input)).id).toBe(turn.id)
  expect(repository.getThread(thread.id).turns).toHaveLength(1)
  expect(repository.turnContext(turn.id).references[0]).toMatchObject({ text: '想听听你的想法', isSelf: true })
})
test('batch commits count unique source coverage and replace cumulative request usage', async () => {
  const { repository } = await setup(), analysis = await task(repository)
  await repository.recordUsage({ ownerKind: 'analysis', ownerId: analysis.id, requestId: 'failed-request', usage: { outputTokens: 10 } })
  await repository.recordUsage({ ownerKind: 'analysis', ownerId: analysis.id, requestId: 'failed-request', usage: { outputTokens: 20 } })
  await repository.commitBatch(analysis.id, { index: 0, messageIds: ['1'], report, usage: { outputTokens: 30 }, requestId: 'retry-request' })
  await repository.commitBatch(analysis.id, { index: 0, messageIds: ['1'], report, usage: { outputTokens: 30 }, requestId: 'retry-request' })
  expect(repository.getAnalysis(analysis.id)).toMatchObject({ analyzedMessages: 1, usage: { outputTokens: 50 } })
  await repository.commitBatch(analysis.id, { index: 1, messageIds: ['1', '2'], report, usage: {} })
  expect(repository.getAnalysis(analysis.id).analyzedMessages).toBe(2)
  expect(repository.getAnalysis(analysis.id).usage.incomplete).toBe(true)
})
test('invalid reports never publish completion or overwrite the previous valid result', async () => {
  const { repository } = await setup(), analysis = await task(repository)
  await expect(repository.completeAnalysis(analysis.id, report)).rejects.toHaveProperty('code')
  await repository.commitBatch(analysis.id, { index: 0, messageIds: ['1', '2'], report, usage: {} })
  await expect(repository.completeAnalysis(analysis.id, { ...report, observations: [{ ...report.observations[0], evidenceMessageIds: ['3'] }] })).rejects.toHaveProperty('code')
  expect(repository.getAnalysis(analysis.id).state).not.toBe('completed')
  await repository.completeAnalysis(analysis.id, report)
  expect(repository.getReport(analysis.id)).toEqual(report)
  const second = await task(repository, 'second')
  await repository.saveAnalysis(second.id, { state: 'failed' })
  expect(repository.getReport(analysis.id)).toEqual(report)
})
test('identity changes invalidate results and prevent old source history from entering the next context', async () => {
  const { store, repository } = await setup(), analysis = await task(repository)
  await repository.commitBatch(analysis.id, { index: 0, messageIds: ['1', '2'], report, usage: {} })
  await repository.completeAnalysis(analysis.id, report)
  const thread = await repository.openThread('1'), first = await repository.createTurn({ threadId: thread.id, requestId: 'one', prompt: '看看这段', referenceIds: ['1'], modelId: 'example' })
  await repository.saveTurn(first.id, { state: 'completed', text: '曾引用旧身份原文', checkpoint: 'native-old' })
  changeSelf(store)
  expect(repository.getAnalysis(analysis.id).valid).toBe(false)
  const next = await repository.createTurn({ threadId: thread.id, requestId: 'two', prompt: '重新讨论', referenceIds: [], modelId: 'example' })
  expect(repository.turnContext(next.id)).toMatchObject({ history: [], profile: null, checkpoint: null })
})
test('restart preserves committed batches, interrupts active work and ignores late terminal callbacks', async () => {
  const { store, repository } = await setup(), analysis = await task(repository)
  await repository.commitBatch(analysis.id, { index: 0, messageIds: ['1'], report, usage: {} })
  const thread = await repository.openThread('1'), turn = await repository.createTurn({ threadId: thread.id, requestId: 'one', prompt: '继续', referenceIds: [], modelId: 'example' })
  await repository.saveTurn(turn.id, { state: 'running', text: '部分文字' })
  const fresh = createAiRepository(store, async operation => operation())
  await fresh.recover()
  expect(fresh.getAnalysis(analysis.id)).toMatchObject({ state: 'interrupted', analyzedMessages: 1 })
  expect(fresh.getThread(thread.id).turns[0]).toMatchObject({ state: 'interrupted', text: '部分文字' })
  await fresh.saveAnalysis(analysis.id, { state: 'running' })
  await fresh.saveTurn(turn.id, { state: 'completed', text: '过期回调' })
  expect(fresh.getAnalysis(analysis.id).state).toBe('interrupted')
  expect(fresh.getThread(thread.id).turns[0].text).toBe('部分文字')
})
test('schema three upgrades preserve imported sources and failed upgrades roll back', async () => {
  for (const conflict of [false, true]) {
    const temp = temporaryStore(), old = new Database(temp.path)
    old.exec(schema); old.exec(selfOptOutSchema); old.exec(importStateSchema)
    old.exec("PRAGMA user_version=3; INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'保留', 'direct',0); INSERT INTO messages(conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,'unknown','','text','保留原文',0)")
    if (conflict) old.exec('CREATE TABLE ai_models(marker TEXT)')
    old.close()
    try {
      if (conflict) {
        expect(() => openStore(temp.path)).toThrow()
        const unchanged = new Database(temp.path)
        expect(unchanged.pragma('user_version', { simple: true })).toBe(3)
        expect(unchanged.prepare('SELECT text FROM messages').get()).toEqual({ text: '保留原文' }); unchanged.close()
      } else {
        const upgraded = openStore(temp.path)
        expect(upgraded.reader.prepare('SELECT text FROM messages').get()).toEqual({ text: '保留原文' })
        expect(upgraded.writer.pragma('foreign_key_check')).toEqual([]); upgraded.close()
      }
    } finally { temp.cleanup() }
  }
})

test('internal storage dispatch rejects unknown operations and shares the import writer queue', async () => {
  const { store, repository, path } = await setup()
  const service = createDataService({ store, appDataDirectory: path })
  await service.ready
  const dispatch = createDataDispatcher(store, service, repository)
  expect(await dispatch('aiStorage', ['listModels', []])).toHaveLength(1)
  for (const payload of [['constructor', []], ['modelSecret', []], ['recover', ['extra']], ['listModels', [], 'extra']]) {
    await expect(dispatch('aiStorage', payload)).rejects.toHaveProperty('code')
  }
  await service.write(() => { store.writer.prepare("UPDATE conversations SET title='队列中修改' WHERE id=1").run() })
  expect((await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' })).title).toBe('队列中修改')
})

test('identity changes during a response reject its completion and preserve the previous text', async () => {
  const { store, repository } = await setup(), thread = await repository.openThread('1')
  const turn = await repository.createTurn({ threadId: thread.id, requestId: 'one', prompt: '解释选区', referenceIds: ['1'], modelId: 'example' })
  await repository.saveTurn(turn.id, { state: 'running', text: '已返回文字' })
  changeSelf(store)
  await expect(repository.saveTurn(turn.id, { state: 'completed', text: '晚到的旧身份回答' })).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' })
  expect(repository.getThread(thread.id).turns[0].text).toBe('已返回文字')
})

test('confirmations and interrupted analysis cannot mix results from different prompt versions', async () => {
  const { store, repository } = await setup()
  const preparation = await repository.prepareAnalysis({ conversationId: '1', modelId: 'example' }, 1000)
  store.writer.prepare('UPDATE ai_preparations SET prompt_version=? WHERE token=?').run('previous-instructions', preparation.token)
  await expect(repository.confirmAnalysis({ token: preparation.token, requestId: 'stale-confirmation' }, 1001)).rejects.toMatchObject({ code: 'PROMPT_CHANGED' })
  expect(repository.listAnalyses()).toEqual([])
  const analysis = await task(repository)
  await repository.commitBatch(analysis.id, { index: 0, messageIds: ['1'], report, usage: {} })
  await repository.saveAnalysis(analysis.id, { state: 'interrupted' })
  store.writer.prepare('UPDATE ai_analysis_tasks SET prompt_version=? WHERE id=?').run('previous-instructions', BigInt(analysis.id))
  expect(() => repository.analysisContext(analysis.id)).toThrowError(expect.objectContaining({ code: 'PROMPT_CHANGED' }))
  await expect(repository.resumeAnalysis(analysis.id)).rejects.toMatchObject({ code: 'PROMPT_CHANGED' })
  expect(repository.getAnalysis(analysis.id)).toMatchObject({ state: 'interrupted', analyzedMessages: 1 })
})
