import { afterEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { openStore } from '../../electron/data/db/open'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiRepository } from '../../electron/data/ai/repository'
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

test('提示词逐项保存、拒绝空值和超限，恢复默认并在重启后保留', async () => {
  const { temp, store, settings, write } = await setup()
  const defaults = settings.getPrompts()
  expect(Object.keys(defaults).sort()).toEqual(['dialogue', 'insightChecking', 'insightReading', 'insightWriting'])
  await settings.savePrompt('dialogue', '用具体情境回答。')
  await settings.savePrompt('insightWriting', '保留我的表达方式。')
  await expect(settings.savePrompt('dialogue', '  ')).rejects.toThrow()
  await expect(settings.savePrompt('dialogue', '字'.repeat(20001))).rejects.toThrow()
  await expect(settings.savePrompt('unknown' as any, 'test')).rejects.toThrow()
  expect(settings.getPrompts().dialogue).toBe('用具体情境回答。')
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const restored = createSettingsRepository(reopened, write); await restored.initialize()
  expect(restored.getPrompts()).toMatchObject({ dialogue: '用具体情境回答。', insightWriting: '保留我的表达方式。' })
  await restored.savePrompt('dialogue', defaults.dialogue)
  expect(restored.getPrompts()).toEqual({ ...defaults, insightWriting: '保留我的表达方式。' })
})

test('洞察任务创建时冻结提示词，续跑和重启不会读取后来的设置', async () => {
  const { temp, store, settings, ai, write } = await setup()
  await settings.savePrompt('insightReading', '取材甲')
  const preparation = await ai.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const task = await ai.confirmAnalysis({ token: preparation.token, requestId: 'one' })
  await ai.saveAnalysis(task.id, { state: 'stopped' })
  await settings.savePrompt('insightReading', '取材乙')
  expect(ai.analysisContext(task.id).systemPrompts?.insightReading).toBe('取材甲')
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const restored = createAiRepository(reopened, write)
  await restored.resumeAnalysis(task.id)
  expect(restored.analysisContext(task.id).systemPrompts?.insightReading).toBe('取材甲')
  await restored.saveAnalysis(task.id, { state: 'stopped' })
  const next = await restored.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  const second = await restored.confirmAnalysis({ token: next.token, requestId: 'two' })
  expect(restored.analysisContext(second.id).systemPrompts?.insightReading).toBe('取材乙')
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

test('保存的对话和洞察提示词进入模型请求，连接检测保持固定指令', async () => {
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
  const { settings, ai, temp } = await setup(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)
  const service = createAiService({
    storage: (method, args) => Reflect.apply(Reflect.get(ai, method), ai, args),
    secrets: { encrypt: value => value, decrypt: value => value },
    runtime: new PiRuntime(dirname(temp.path)),
  })
  cleanup.push(() => service.close())
  await settings.savePrompt('dialogue', '对话用简短句子。')
  const thread = await ai.createThread('1')
  await service.sendTurn({ threadId: thread.id, requestId: 'dialogue', modelId: 'm', prompt: '你好', referenceIds: [] })
  await service.idle()
  expect(requests[0].messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('对话用简短句子。') })
  await settings.savePrompt('insightReading', '记录具体动作。')
  await settings.savePrompt('insightChecking', '对照原话核查。')
  await settings.savePrompt('insightWriting', '成稿保留细节。')
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
    for (const prompt of ['记录具体动作。', '对照原话核查。', '成稿保留细节。']) expect(system).toContain(prompt)
  }
  expect(readTurns(insightRequests[1])).toMatchObject([{ result: { status: 'ok', messages: [{ id: '1', text: '周末一起散步' }] } }])
  await service.testModel('m')
  const probe = requests.at(-1)!
  expect(probe.messages).toEqual([
    { role: 'system', content: expect.stringMatching(/^Reply OK\.(?:\n|$)/) },
    { role: 'user', content: [{ type: 'text', text: 'OK' }] },
  ])
  expect(JSON.stringify(probe)).not.toMatch(/对话用简短句子|记录具体动作|对照原话核查|成稿保留细节/)
}, 30000)
