import { afterEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { openStore } from '../../electron/data/db/open'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiRepository } from '../../electron/data/ai/repository'
import { legacyPrompts, priorInsightDefaults } from '../../electron/data/ai/legacy-prompts'
import { defaultPrompts, maxPromptLength } from '../../src/shared/system-prompts'
import { temporaryStore } from './helpers'
import { createAiService } from '../../electron/main/ai-service'
import { completeModel, readTurns, sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(baseUrl = 'http://127.0.0.1:9999/v1') {
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
  await ai.saveModel({ id: 'm', label: '测试', model: 'm', baseUrl, contextWindow: 8000, maxTokens: 1000, enabled: true })
  await settings.initialize()
  return { temp, store, settings, ai, write }
}

test('提示词逐项保存和恢复默认，清空洞察偏好后重启仍为空', async () => {
  const { temp, store, settings, write } = await setup()
  const defaults = settings.getPrompts()
  expect(Object.keys(defaults).sort()).toEqual(['dialogue', 'insight'])
  await settings.savePrompt('dialogue', '用具体情境回答。')
  await settings.savePrompt('insight', '')
  for (const blank of ['', '  ']) await expect(settings.savePrompt('dialogue', blank)).rejects.toThrow('请输入提示词。')
  for (const id of ['dialogue', 'insight'] as const) {
    await expect(settings.savePrompt(id, '字'.repeat(maxPromptLength + 1))).rejects.toThrow('请缩短后保存')
    await expect(settings.savePrompt(id, null as unknown as string)).rejects.toThrow()
  }
  await expect(settings.savePrompt('unknown' as any, 'test')).rejects.toThrow()
  expect(settings.getPrompts().dialogue).toBe('用具体情境回答。')
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const restored = createSettingsRepository(reopened, write); await restored.initialize()
  expect(restored.getPrompts()).toEqual({ dialogue: '用具体情境回答。', insight: '' })
  await restored.savePrompt('dialogue', defaults.dialogue)
  await restored.savePrompt('insight', defaults.insight)
  expect(restored.getPrompts()).toEqual(defaults)
})

test.each([legacyPrompts, priorInsightDefaults])('旧版三个洞察默认值迁移为统一风格偏好', async oldDefaults => {
  const { settings, store } = await setup()
  store.writer.prepare('INSERT OR REPLACE INTO app_settings(key,data) VALUES(?,?)')
    .run('systemPrompts', JSON.stringify({ ...oldDefaults, dialogue: '保留我的对话设置。' }))
  expect(settings.getPrompts()).toEqual({ dialogue: '保留我的对话设置。', insight: defaultPrompts.insight })
})

test('按阅读、核查、成稿的顺序合并自定义内容，保存洞察偏好后清除旧键', async () => {
  const { settings, store } = await setup()
  const write = store.writer.prepare('INSERT OR REPLACE INTO app_settings(key,data) VALUES(?,?)')
  const old = { insightWriting: '保留措辞。', dialogue: '简短回答。', insightChecking: '关注变化。', insightReading: '关注细节。' }
  write.run('systemPrompts', JSON.stringify(old))
  expect(settings.getPrompts().insight).toBe('关注细节。\n\n关注变化。\n\n保留措辞。')
  write.run('systemPrompts', JSON.stringify({ ...old, insightChecking: priorInsightDefaults.insightChecking }))
  const merged = '关注细节。\n\n保留措辞。'
  expect(settings.getPrompts().insight).toBe(merged)
  for (const insight of [merged, '', defaultPrompts.insight]) {
    write.run('systemPrompts', JSON.stringify({ ...old, insight: '' }))
    expect(settings.getPrompts().insight).toBe('')
    await settings.savePrompt('insight', insight)
    const row = store.reader.prepare("SELECT data FROM app_settings WHERE key='systemPrompts'").get() as { data: string }
    expect(JSON.parse(row.data)).toEqual(insight === defaultPrompts.insight ? { dialogue: old.dialogue } : { dialogue: old.dialogue, insight })
  }
})

test('洞察任务创建时冻结提示词，续跑和重启不会读取后来的设置', async () => {
  const { temp, store, settings, ai, write } = await setup()
  await settings.savePrompt('insight', '偏好甲')
  const preparation = await ai.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await ai.confirmAnalysis({ token: preparation.token, requestId: 'one' })
  await ai.saveAnalysis(task.id, { state: 'stopped' })
  await settings.savePrompt('insight', '偏好乙')
  const frozen = { ...defaultPrompts, insight: '偏好甲' }
  const row = store.reader.prepare('SELECT prompt_snapshot FROM ai_analysis_tasks WHERE id=?').get(task.id) as { prompt_snapshot: string }
  expect(JSON.parse(row.prompt_snapshot)).toEqual(frozen)
  expect(ai.analysisContext(task.id).systemPrompts).toEqual(frozen)
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, write)
  await restored.resumeAnalysis(task.id)
  expect(restored.analysisContext(task.id).systemPrompts).toEqual(frozen)
  await restored.saveAnalysis(task.id, { state: 'stopped' })
  const next = await restored.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const second = await restored.confirmAnalysis({ token: next.token, requestId: 'two' })
  expect(restored.analysisContext(second.id).systemPrompts).toEqual({ ...defaultPrompts, insight: '偏好乙' })
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

async function setupModel() {
  type Request = { messages: { role: string; content: string | { type: string; text: string }[] }[]; tools?: { function: { name: string } }[] }
  const requests: Request[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const input: Request = JSON.parse(body)
    requests.push(input)
    if (!input.tools?.length) return completeModel(response, { text: 'OK' })
    const turns = readTurns(input)
    if (!turns.length) return completeModel(response, { read: {} })
    const section = [{ content: [{ text: '约周末散步', citationId: 'walk' }] }]
    const report = { aboutYou: section, relationship: section, limitations: [], judgments: sampleJudgments(),
      citations: [{ id: 'walk', fragments: [{ messageIds: ['1'] }] }] }
    completeModel(response, { text: JSON.stringify(report) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const { settings, ai, temp, store } = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)
  const service = createAiService({
    storage: (method, args) => Reflect.apply(Reflect.get(ai, method), ai, args),
    secrets: { encrypt: value => value, decrypt: value => value },
    runtime: new PiRuntime(dirname(temp.path)),
  })
  cleanup.push(() => service.close())
  return { requests, settings, ai, service, store }
}

test('保存的对话和洞察偏好进入模型请求，连接检测保持固定指令', async () => {
  const { requests, settings, ai, service } = await setupModel()
  await settings.savePrompt('dialogue', '对话用简短句子。')
  const thread = await ai.createThread('1')
  await service.sendTurn({ threadId: thread.id, requestId: 'dialogue', modelId: 'm', prompt: '你好', referenceIds: [] })
  await service.idle()
  expect(requests[0].messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('对话用简短句子。') })
  await settings.savePrompt('insight', '保留散步时的细节。')
  const prep = await service.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await service.confirmAnalysis({ token: prep.token, requestId: 'insight' })
  await service.idle()
  expect(ai.getAnalysis(task.id)).toMatchObject({ state: 'completed', analyzedMessages: 1 })
  const insightRequests = requests.slice(1)
  expect(insightRequests).toHaveLength(2)
  for (const input of insightRequests) {
    expect(input.tools?.map(tool => tool.function.name)).toEqual(['read_messages'])
    expect(JSON.stringify(input)).not.toContain('<cwd>')
    const system = input.messages.find(message => message.role === 'system')?.content
    expect(system).toContain('[Layer 3: Whomi editable preferences]\n\n保留散步时的细节。')
  }
  expect(readTurns(insightRequests[1])).toMatchObject([{ result: { status: 'ok', messages: [{ id: '1', text: '周末一起散步' }] } }])
  await service.testModel('m')
  const probe = requests.at(-1)!
  expect(probe.messages).toEqual([
    { role: 'system', content: expect.stringMatching(/^Reply OK\.(?:\n|$)/) },
    { role: 'user', content: [{ type: 'text', text: 'OK' }] },
  ])
  expect(JSON.stringify(probe)).not.toMatch(/对话用简短句子|保留散步时的细节/)
}, 30000)

test('清空洞察偏好后，实际模型请求只包含固定要求和分析方法', async () => {
  const { requests, settings, ai, service } = await setupModel()
  await settings.savePrompt('insight', '')
  const prep = await service.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await service.confirmAnalysis({ token: prep.token, requestId: 'cleared' })
  await service.idle()
  expect(ai.getAnalysis(task.id).state).toBe('completed')
  expect(ai.analysisContext(task.id).systemPrompts).toEqual({ ...defaultPrompts, insight: '' })
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    const system = request.messages.find(message => message.role === 'system')?.content
    expect(system).toContain('[Layer 2:')
    expect(system).not.toContain('[Layer 3:')
    expect(system).not.toContain(defaultPrompts.insight)
  }
}, 30000)

test('恢复旧版已暂停的方法任务时逐字发送三个冻结提示词', async () => {
  const { requests, settings, ai, service, store } = await setupModel()
  const prep = await ai.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await ai.confirmAnalysis({ token: prep.token, requestId: 'legacy' })
  await ai.saveAnalysis(task.id, { state: 'stopped' })
  const frozen = { dialogue: '旧对话', insightWriting: '成稿保留细节。', insightChecking: priorInsightDefaults.insightChecking, insightReading: '  旧阅读\n第二行。' }
  store.writer.prepare('UPDATE ai_analysis_tasks SET prompt_snapshot=? WHERE id=?').run(JSON.stringify(frozen), task.id)
  await settings.savePrompt('insight', '新的洞察偏好。')
  await service.continueAnalysis(task.id)
  await service.idle()
  expect(ai.getAnalysis(task.id).state).toBe('completed')
  expect(ai.analysisContext(task.id).systemPrompts).toEqual(frozen)
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    const system = request.messages.find(message => message.role === 'system')?.content
    expect(system).toContain(`[Layer 3: Whomi editable preferences]\n\n${frozen.insightReading}\n${frozen.insightChecking}\n${frozen.insightWriting}`)
    expect(system).not.toContain('新的洞察偏好。')
  }
}, 30000)
