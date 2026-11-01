import { afterEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { openStore } from '../../electron/data/db/open'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiRepository } from '../../electron/data/ai/repository'
import { temporaryStore } from './helpers'
import { createAiService } from '../../electron/main/ai-service'
import { defaultPrompts } from '../../src/shared/system-prompts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))
async function setup() {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanup.push(() => { store.close(); temp.cleanup() })
  let queue: Promise<unknown> = Promise.resolve()
  const write = <T,>(operation: () => T | Promise<T>): Promise<T> => { const next = queue.then(operation); queue = next.catch(() => {}); return next }
  const settings = createSettingsRepository(store, write)
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'提示词测试','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','周末一起散步',0)`)
  const ai = createAiRepository(store, write)
  await ai.saveModel({ id: 'm', label: '测试', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, enabled: true })
  await settings.initialize()
  return { temp, store, settings, ai, write }
}

test('提示词逐项保存、拒绝空值和超限，恢复默认并在重启后保留', async () => {
  const { temp, store, settings, write } = await setup()
  const defaults = settings.getPrompts()
  expect(Object.keys(defaults)).toEqual(['dialogue', 'memorySource', 'memoryMerge', 'memoryFinal'])
  await settings.savePrompt('dialogue', '用具体情境回答。')
  await settings.savePrompt('memoryFinal', '保留我的表达方式。')
  await expect(settings.savePrompt('dialogue', '  ')).rejects.toThrow()
  await expect(settings.savePrompt('dialogue', '字'.repeat(20001))).rejects.toThrow()
  await expect(settings.savePrompt('unknown' as any, 'test')).rejects.toThrow()
  expect(settings.getPrompts().dialogue).toBe('用具体情境回答。')
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const restored = createSettingsRepository(reopened, write); await restored.initialize()
  expect(restored.getPrompts()).toMatchObject({ dialogue: '用具体情境回答。', memoryFinal: '保留我的表达方式。' })
  await restored.savePrompt('dialogue', defaults.dialogue)
  expect(restored.getPrompts()).toEqual({ ...defaults, memoryFinal: '保留我的表达方式。' })
})

test('记忆任务创建时冻结提示词，续跑和重启不会读取后来的设置', async () => {
  const { temp, store, settings, ai, write } = await setup()
  await settings.savePrompt('memorySource', '取材甲')
  const preparation = await ai.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await ai.confirmAnalysis({ token: preparation.token, requestId: 'one' })
  await ai.saveAnalysis(task.id, { state: 'stopped' })
  await settings.savePrompt('memorySource', '取材乙')
  expect(ai.analysisContext(task.id).systemPrompts?.memorySource).toBe('取材甲')
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, write)
  await restored.resumeAnalysis(task.id)
  expect(restored.analysisContext(task.id).systemPrompts?.memorySource).toBe('取材甲')
  await restored.saveAnalysis(task.id, { state: 'stopped' })
  const next = await restored.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const second = await restored.confirmAnalysis({ token: next.token, requestId: 'two' })
  expect(restored.analysisContext(second.id).systemPrompts?.memorySource).toBe('取材乙')
})

test('对话修改提示词后不复用旧上下文，失败重试仍使用原轮次提示词', async () => {
  const { settings, ai } = await setup()
  const thread = await ai.createThread('1')
  await settings.savePrompt('dialogue', '对话甲')
  const first = await ai.createTurn({ threadId: thread.id, requestId: 'one', modelId: 'm', prompt: '问题', referenceIds: [] })
  await ai.saveTurn(first.id, { state: 'completed', text: '回答', checkpoint: 'previous' })
  await settings.savePrompt('dialogue', '对话乙')
  const next = await ai.createTurn({ threadId: thread.id, requestId: 'two', modelId: 'm', prompt: '新问题', referenceIds: [] })
  expect(ai.turnContext(next.id)).toMatchObject({ systemPrompt: '对话乙', checkpoint: null })
  await ai.saveTurn(next.id, { state: 'failed' })
  await settings.savePrompt('dialogue', '对话丙')
  await ai.beginRetryTurn(next.id)
  expect(ai.turnContext(next.id).systemPrompt).toBe('对话乙')
})

test('升级已有资料库后可按旧断点继续对话，旧记忆任务不使用新配置', async () => {
  const { store, temp, ai, write } = await setup()
  const thread = await ai.createThread('1')
  const prior = await ai.createTurn({ threadId: thread.id, requestId: 'before', modelId: 'm', prompt: '原问题', referenceIds: [] })
  const { selfFingerprint, model } = ai.turnContext(prior.id)
  const oldKey = createHash('sha256').update(JSON.stringify(['thread', thread.id, selfFingerprint, model.id, model.version, null, null, null])).digest('hex')
  await ai.saveTurn(prior.id, { state: 'completed', text: '原回答', checkpoint: oldKey })
  const prep = await ai.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await ai.confirmAnalysis({ token: prep.token, requestId: 'old-task' })
  store.writer.exec('ALTER TABLE ai_analysis_tasks DROP COLUMN prompt_snapshot; ALTER TABLE ai_turns DROP COLUMN system_prompt; PRAGMA user_version=7')
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const upgraded = createAiRepository(reopened, write)
  const config = createSettingsRepository(reopened, write)
  await config.savePrompt('memorySource', '这是升级后才保存的取材规则。')
  expect(upgraded.analysisContext(task.id).systemPrompts).toBeUndefined()
  const service = createAiService({
    storage: async (method, args) => (upgraded[method as keyof typeof upgraded] as (...values: any[]) => unknown)(...args),
    secrets: { encrypt: value => value, decrypt: value => value },
    runtime: { run: async input => {
      if (input.checkpoint !== oldKey || input.key !== oldKey) throw new Error('旧断点目录不匹配')
      return { text: '新回答', usage: {}, checkpoint: oldKey }
    } },
  })
  const turn = await service.sendTurn({ threadId: thread.id, requestId: 'after', modelId: 'm', prompt: '继续', referenceIds: [] })
  await service.idle()
  expect(upgraded.turnContext(turn.id).turn.state).toBe('completed')
  await service.close()
})

test('保存的对话和记忆提示词进入模型请求，连接检测保持固定指令', async () => {
  const { settings, ai } = await setup()
  const requests: { systemPrompt: string; prompt: string }[] = []
  const service = createAiService({
    storage: async (method, args) => (ai[method as keyof typeof ai] as (...values: any[]) => unknown)(...args),
    secrets: { encrypt: value => value, decrypt: value => value },
    runtime: { run: async input => {
      requests.push(input)
      const payload = input.prompt.startsWith('{') ? JSON.parse(input.prompt) : {}
      const text = payload.messages ? { events: [{ key: 'walk', text: '周末散步', evidenceMessageIds: ['1'], signals: [] }] }
        : payload.events ? { groups: [['walk']], events: [{ key: 'walk', title: '散步', text: '周末散步。' }], relationship: '一起度过周末。', dimensionExplanations: { EI: null, SN: null, TF: null, JP: null } }
        : '测试回答'
      return { text: typeof text === 'string' ? text : JSON.stringify(text), usage: {}, checkpoint: 'checkpoint' }
    } },
  })
  await settings.savePrompt('dialogue', '对话用简短句子。')
  const thread = await ai.createThread('1')
  await service.sendTurn({ threadId: thread.id, requestId: 'dialogue', modelId: 'm', prompt: '你好', referenceIds: [] })
  await service.idle()
  expect(requests[0].systemPrompt).toContain('对话用简短句子。')
  await settings.savePrompt('memorySource', '记录具体动作。')
  await settings.savePrompt('memoryMerge', '仅在材料超长时归并。'.repeat(1000))
  await settings.savePrompt('memoryFinal', '成稿保留细节。')
  const prep = await service.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await service.confirmAnalysis({ token: prep.token, requestId: 'memory' })
  await service.idle()
  expect(ai.getAnalysis(task.id).state).toBe('completed')
  expect(requests[1].systemPrompt).toContain('记录具体动作。')
  expect(requests[2].systemPrompt).toContain('成稿保留细节。')
  expect(requests[2].systemPrompt).toContain('dimensionExplanations')
  await service.testModel('m')
  expect(requests.at(-1)).toMatchObject({ systemPrompt: 'Reply OK.', prompt: 'OK' })
  expect(defaultPrompts.dialogue).not.toBe('对话用简短句子。')
  await service.close()
})
