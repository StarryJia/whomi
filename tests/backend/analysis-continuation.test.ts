import { afterEach, expect, test } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiService, type RuntimeRunner } from '../../electron/main/ai-service'
import { temporaryStore } from './helpers'
import { currentMemoryContributions } from '../../src/shared/memory'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function connection(path: string) {
  const store = openStore(path)
  cleanups.push(() => { if (store.writer.open) store.close() })
  const write = async <T,>(operation: () => T | Promise<T>) => operation()
  return { store, repository: createAiRepository(store, write), settings: createSettingsRepository(store, write) }
}

async function fixture(legacy: 'conversation-analysis-v1' | 'conversation-memory-v2' | 'conversation-memory-v3' | 'conversation-memory-v4' | false = 'conversation-analysis-v1') {
  const temp = temporaryStore(); cleanups.push(temp.cleanup)
  const data = connection(temp.path)
  if (legacy) data.store.writer.exec(`CREATE TEMP TRIGGER old_analysis AFTER INSERT ON ai_analysis_tasks BEGIN
    UPDATE ai_analysis_tasks SET prompt_version='${legacy}' WHERE id=NEW.id; END`)
  data.store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'合成会话','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'test','test');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'self','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user')`)
  const insert = data.store.writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(?,1,1,'member','本人','text',?,?)")
  for (let id = 1; id <= 3; id++) insert.run(id, 'a'.repeat(1400), id)
  await data.repository.saveModel({ id: 'model', label: '合成模型', model: 'fixture', baseUrl: 'http://localhost:9123/v1', contextWindow: 8000, maxTokens: 1000, maxInputTokens: 4000, enabled: true })
  await data.settings.initialize()
  return { data, path: temp.path }
}

function analysisService(data: ReturnType<typeof connection>, run: RuntimeRunner['run']) {
  return createAiService({
    storage: (method, args) => Reflect.apply(Reflect.get(data.repository, method), data.repository, args),
    processing: async () => ({ settings: data.settings.get().processing, members: [{ id: '1', displayName: '本人' }] }),
    claimProcessing: data.settings.claimProcessing,
    runtime: { run }, secrets: { encrypt: value => value, decrypt: value => value },
  })
}

function requestKind(prompt: string): string {
  return prompt.startsWith('{') ? JSON.parse(prompt).messages.map((item: { id: string }) => item.id).join(',') : 'summary'
}
const response = { text: JSON.stringify({ summary: '合成观察', observations: [], limitations: '仅限样例' }), usage: { inputTokens: 10, outputTokens: 2 }, checkpoint: 'fixture' }

test('a new manuscript merges the first and third moving fragments and only admits supported dimensions', async () => {
  const { data } = await fixture(false)
  const requests: string[] = []
  const dims = { EI: null, SN: null, TF: null, JP: null }
  const service = analysisService(data, async input => {
    const payload = JSON.parse(input.prompt)
    if (payload.messages) {
      const id = payload.messages[0].id
      requests.push(id)
      if (id === '3') expect(payload.knownEvents).toContain('周六搬家')
      const key = id === '2' ? '试讲' : id === '1' ? '周六搬家' : payload.knownEvents.find((key: string) => key.includes('搬家'))
      return { ...response, text: JSON.stringify({ events: [{ key, text: ['约好搬家日期','试讲结束','货车已经到了'][Number(id) - 1], evidenceMessageIds: [id], signals: [] }] }) }
    }
    requests.push('final')
    const moving = payload.events.filter((event: {key:string}) => event.key === '周六搬家')
    expect(moving).toHaveLength(1)
    expect(moving[0]).toMatchObject({ messageCount: 2 })
    return { ...response, text: JSON.stringify({ groups: [['周六搬家'],['试讲']], dimensionExplanations: dims, events: [{ key: '周六搬家', title: '周六搬家', text: '约好日期后等到了货车。' }], relationship: '你们似乎能彼此分工。' }) }
  })
  const task = await start(service)
  await service.idle()
  expect(data.repository.getAnalysis(task.id)).toMatchObject({ state: 'completed', conversationTitle: '合成会话', report: {
    format: 'memory-v4', dimensions: dims, dimensionExplanations: dims, events: [{ title: '周六搬家', text: '约好日期后等到了货车。' }], relationship: '你们似乎能彼此分工。' } })
  expect(requests).toEqual(['1','2','3','final'])
})

async function start(service: ReturnType<typeof analysisService>) {
  const preparation = await service.prepareAnalysis({ conversationId: '1', modelId: 'model' })
  return service.confirmAnalysis({ token: preparation.token, requestId: 'fixture' })
}

test.each(['conversation-memory-v2', 'conversation-memory-v3', 'conversation-memory-v4'] as const)('a saved %s source batch resumes with its own writing instructions after upgrade', async version => {
  const { data, path } = await fixture(version)
  const notes = (id: string) => ({ events: [{ key: '搬家', text: '事先安排', evidenceMessageIds: [id], signals: [{ direction: 'J', messageId: id }] }] })
  const waiting = Promise.withResolvers<void>()
  const first = analysisService(data, async (input, { signal }) => {
    const id = JSON.parse(input.prompt).messages[0].id
    if (id === '2') {
      waiting.resolve()
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return { ...response, text: JSON.stringify(notes(id)) }
  })
  const task = await start(first)
  await waiting.promise
  await first.close()
  data.store.close()
  const reopened = connection(path), seen: string[] = []
  const resumed = analysisService(reopened, async input => {
    const payload = JSON.parse(input.prompt)
    if (version !== 'conversation-memory-v4') expect(input.systemPrompt).not.toContain('dimensionExplanations')
    if (payload.messages) {
      const id = payload.messages[0].id
      seen.push(id)
      return { ...response, text: JSON.stringify(notes(id)) }
    }
    return { ...response, text: JSON.stringify({ ...(version === 'conversation-memory-v2' ? { dimensions: { EI: null, SN: null, TF: null, JP: 'J' } } : { groups: [['搬家']] }),
      ...(version === 'conversation-memory-v4' ? { dimensionExplanations: { EI: null, SN: null, TF: null, JP: null } } : {}),
      events: [{ key: '搬家', title: '搬家', text: '先订好了车。' }], relationship: '你们有商有量。' }) }
  })
  await resumed.continueAnalysis(task.id)
  await resumed.idle()
  expect(seen).toEqual(['2','3'])
  expect(reopened.repository.getReport(task.id)).toMatchObject({ format: version.replace('conversation-', ''), dimensions: { JP: version === 'conversation-memory-v2' ? 'J' : null } })
  expect(reopened.repository.listAnalyses()).toHaveLength(1)
})

test('a v4 task saves contextual explanations from self signals and restores the same manuscript after restart', async () => {
  const { data, path } = await fixture(false)
  const contexts = ['搬家前我先订货车。', '看展前我先订票。', '试讲前我先写提纲。']
  for (let i = 0; i < contexts.length; i++) data.store.writer.prepare('UPDATE messages SET text=? WHERE id=?').run(contexts[i] + '补充。'.repeat(450), i + 1)
  const service = analysisService(data, async input => {
    const payload = JSON.parse(input.prompt)
    if (payload.messages) {
      const id = payload.messages[0].id
      return { ...response, text: JSON.stringify({ events: [{ key: id, text: contexts[Number(id) - 1], evidenceMessageIds: [id], signals: [{ direction: 'J', messageId: id }] }] }) }
    }
    expect(payload.events.every((event: { signals: unknown[] }) => event.signals.length)).toBe(true)
    return { ...response, text: JSON.stringify({ groups: [['1'], ['2'], ['3']], events: [{ key: '1', title: '搬家', text: contexts[0] }], relationship: '你们会一起准备。',
      dimensionExplanations: { EI: null, SN: null, TF: null, JP: { text: '搬家订车、看展订票和试讲列提纲时，你都主动提前安排。', eventKeys: ['1', '2', '3'] } } }) }
  })
  const task = await start(service)
  await service.idle()
  expect(data.repository.getAnalysis(task.id).state).toBe('completed')
  const saved = data.repository.getReport(task.id)
  expect(saved).toMatchObject({ format: 'memory-v4', dimensions: { JP: 'J' }, eventVotes: { JP: [3, 0] },
    dimensionExplanations: { JP: { text: '搬家订车、看展订票和试讲列提纲时，你都主动提前安排。', evidenceMessageIds: ['1', '2', '3'] } } })
  await service.close()
  data.store.close()
  const reopened = connection(path)
  expect(reopened.repository.getReport(task.id)).toEqual(saved)
  expect(currentMemoryContributions(reopened.repository.listAnalyses())).toMatchObject([{ conversationId: '1', taskId: task.id, dimensions: { JP: 'J' } }])
})

test('immediate continuation waits for the stopped attempt and skips the committed source batch', async () => {
  const { data } = await fixture()
  const calls: string[] = []
  const second = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = analysisService(data, async input => {
    calls.push(requestKind(input.prompt))
    if (calls.length === 2) { second.resolve(); await release.promise }
    return response
  })
  const task = await start(service)
  await second.promise
  const stopped = await service.stopAnalysis(task.id)
  expect(stopped).toMatchObject({ state: 'stopped', analyzedMessages: 1 })
  const continuation = service.continueAnalysis(task.id)
  await setImmediate()
  const whileDraining = data.repository.getAnalysis(task.id).state
  release.resolve()
  expect((await continuation).id).toBe(task.id)
  await service.idle()
  expect(whileDraining).toBe('stopped')
  expect(calls).toEqual(['1', '2', '2', '3', 'summary'])
  expect(data.repository.getAnalysis(task.id)).toMatchObject({ state: 'completed', analyzedMessages: 3, totalMessages: 3 })
})

test('reopening after interruption during summary reuses persisted batches and the original input range', async () => {
  const { data, path } = await fixture()
  const merging = Promise.withResolvers<void>()
  const service = analysisService(data, async (input, { signal }) => {
    if (requestKind(input.prompt) === 'summary') {
      merging.resolve()
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return response
  })
  const task = await start(service)
  await merging.promise
  await service.close()
  data.store.close()
  const reopened = connection(path)
  expect(reopened.repository.getAnalysis(task.id)).toMatchObject({ state: 'interrupted', analyzedMessages: 3 })
  reopened.store.writer.exec("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(4,1,1,'member','本人','text','暂停后导入的新消息',4)")
  const calls: string[] = []
  const fresh = analysisService(reopened, async input => { calls.push(requestKind(input.prompt)); return response })
  const originalSettings = reopened.settings.get().processing
  await reopened.settings.saveProcessing({ ...originalSettings, clean: !originalSettings.clean })
  await expect(fresh.continueAnalysis(task.id)).rejects.toMatchObject({ code: 'PROCESSING_CHANGED' })
  expect(reopened.repository.getAnalysis(task.id)).toMatchObject({ state: 'interrupted', analyzedMessages: 3 })
  await reopened.settings.saveProcessing(originalSettings)
  await fresh.continueAnalysis(task.id)
  await fresh.idle()
  expect(calls).toEqual(['summary'])
  expect(reopened.repository.getAnalysis(task.id)).toMatchObject({ state: 'completed', analyzedMessages: 3, totalMessages: 3, report: { summary: '合成观察' } })
})

test('continuing a failed multi-step summary reuses its completed merge nodes', async () => {
  const { data } = await fixture()
  const calls: string[] = []
  const service = analysisService(data, async input => {
    const kind = requestKind(input.prompt)
    if (kind !== 'summary') {
      calls.push('source-' + kind)
      const report = { summary: kind + 'a'.repeat(1150), observations: [], limitations: '样例' }
      return { ...response, text: JSON.stringify(report) }
    }
    const group = JSON.parse(input.prompt.slice(input.prompt.indexOf('\n') + 1))
    const key = 'merge-' + group[0].summary.slice(0, 1)
    calls.push(key)
    if (key === 'merge-2' && calls.filter(call => call === key).length === 1) throw Error('synthetic transport failure')
    return response
  })
  const task = await start(service)
  await service.idle()
  expect(data.repository.getAnalysis(task.id)).toMatchObject({ state: 'failed', analyzedMessages: 3 })
  expect(calls).toEqual(['source-1', 'source-2', 'source-3', 'merge-1', 'merge-2'])
  await service.continueAnalysis(task.id)
  await service.idle()
  expect(calls.slice(5)).toEqual(['merge-2', 'merge-3', 'merge-合'])
  expect(data.repository.getAnalysis(task.id).state).toBe('completed')
})
