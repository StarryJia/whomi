import { afterEach, expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { temporaryStore } from './helpers'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { purgeConversation } from '../../electron/data/db/purge'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
async function setup() {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanup.push(() => { store.close(); temp.cleanup() })
  let queue: Promise<unknown> = Promise.resolve()
  const write = <T,>(operation: () => T | Promise<T>): Promise<T> => { const next = queue.then(operation); queue = next.catch(() => {}); return next }
  const settings = createSettingsRepository(store, write), ai = createAiRepository(store, write)
  await settings.initialize()
  return { temp, store, settings, ai, write }
}
const providerInput = { name: '示例服务', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true }
const modelInput = { label: '示例模型', model: 'example-model', contextWindow: 4096, maxTokens: 512, enabled: true }

test('independent maximum input and output metadata remains valid within the context ceiling', async () => {
  const { settings, ai } = await setup(), provider = await settings.saveProvider(providerInput)
  const saved = await settings.saveModel({ ...modelInput, providerId: provider.id, contextWindow: 128000, maxTokens: 16000, maxInputTokens: 128000 })
  expect(settings.get().models[0]).toMatchObject({ contextWindow: 128000, maxTokens: 16000, maxInputTokens: 128000 })
  expect(ai.modelSecret(saved.id).model.maxInputTokens).toBe(128000)
})

test('provider notes and model input limit persist without changing encrypted credentials', async () => {
  const { settings } = await setup()
  const provider = await settings.saveProvider({ ...providerInput, notes: '示例备注' } as Parameters<typeof settings.saveProvider>[0], 'encrypted-original')
  const saved = await settings.saveModel({ ...modelInput, providerId: provider.id, group: '示例组', maxInputTokens: 3000 } as Parameters<typeof settings.saveModel>[0])
  expect(settings.get().providers[0]).toMatchObject({ notes: '示例备注' })
  expect(settings.get().models[0]).toMatchObject({ id: saved.id, group: '示例组', maxInputTokens: 3000 })
  expect(settings.providerSecret(provider.id).encryptedKey).toBe('encrypted-original')
})

test('saved providers, per-feature choices and processing survive restart without exposing encrypted credentials', async () => {
  const { settings, store, temp, write } = await setup()
  const provider = await settings.saveProvider(providerInput, 'encrypted-key')
  const model = await settings.saveModel({ ...modelInput, providerId: provider.id })
  await settings.selectModel('analysis', model.id)
  await settings.saveProcessing({ ...defaultProcessing, mergeSeconds: 12, denoise: true })
  await settings.setDebug(true)
  store.close()
  const reopened = openStore(temp.path); cleanup.push(() => reopened.close())
  const fresh = createSettingsRepository(reopened, write); await fresh.initialize()
  expect(fresh.get()).toMatchObject({ providers: [{ id: provider.id, hasCredential: true }], models: [{ id: model.id, providerId: provider.id }], selectedModels: { analysis: model.id }, processing: { mergeSeconds: 12, denoise: true }, debug: true })
  expect(JSON.stringify(fresh.get())).not.toContain('encrypted-key')
})

test('provider changes update current model versions atomically and removals preserve history', async () => {
  const { settings, ai, store } = await setup()
  const provider = await settings.saveProvider(providerInput, 'encrypted-old')
  const model = await settings.saveModel({ ...modelInput, providerId: provider.id })
  await settings.saveProvider({ ...providerInput, id: provider.id, baseUrl: 'http://127.0.0.1:9876/v1', enabled: false }, 'encrypted-new')
  expect(ai.modelSecret(model.id)).toMatchObject({ model: { enabled: false, version: 2, baseUrl: 'http://127.0.0.1:9876/v1' }, encryptedKey: 'encrypted-new' })
  expect(ai.modelSecret(model.id, 1)).toMatchObject({ model: { enabled: true, version: 1 }, encryptedKey: 'encrypted-old' })
  await expect(settings.selectModel('conversation', model.id)).rejects.toMatchObject({ code: 'INVALID_MODEL' })
  await settings.removeProvider(provider.id)
  expect(settings.get().providers).toEqual([])
  expect(settings.get().models).toEqual([])
  expect(ai.modelSecret(model.id).model.enabled).toBe(false)
  expect(store.reader.prepare('SELECT count(*) n FROM ai_model_versions WHERE model_id=?').get(model.id)).toMatchObject({ n: 3n })
  await settings.initialize()
  expect(settings.get().providers).toEqual([])
})

test('same model names are independent across providers and duplicate saves keep the previous configuration', async () => {
  const { settings } = await setup()
  const a = await settings.saveProvider(providerInput), b = await settings.saveProvider({ ...providerInput, name: '另一个示例服务' })
  const first = await settings.saveModel({ ...modelInput, providerId: a.id })
  const second = await settings.saveModel({ ...modelInput, providerId: b.id })
  expect(first.id).not.toBe(second.id)
  const before = settings.get()
  await expect(settings.saveModel({ ...modelInput, providerId: a.id })).rejects.toMatchObject({ code: 'DUPLICATE_MODEL' })
  await expect(settings.saveProvider({ ...providerInput, id: a.id, baseUrl: 'https://example.test/v1?key=secret' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  await expect(settings.saveProcessing({ ...defaultProcessing, mergeSeconds: 0 })).rejects.toMatchObject({ code: 'INVALID_PROCESSING' })
  expect(settings.get()).toEqual(before)
})

test('legacy models migrate once with encrypted credentials and remain callable through the original model repository', async () => {
  const temp = temporaryStore(), store = openStore(temp.path); cleanup.push(() => { store.close(); temp.cleanup() })
  const write = async <T,>(operation: () => T | Promise<T>) => operation()
  const ai = createAiRepository(store, write)
  await ai.saveModel({ ...modelInput, id: 'legacy', baseUrl: providerInput.baseUrl }, 'encrypted-legacy')
  const settings = createSettingsRepository(store, write); await settings.initialize()
  expect(settings.get().providers).toHaveLength(1)
  expect(settings.get().models[0]).toMatchObject({ id: 'legacy', model: 'example-model', hasCredential: true })
  expect(settings.providerSecret(settings.get().providers[0].id).encryptedKey).toBe('encrypted-legacy')
  expect(ai.modelSecret('legacy').model.version).toBe(1)
  await settings.initialize()
  expect(settings.get().providers).toHaveLength(1)
})

test('running work blocks changes and failed writes retain every linked model and provider', async () => {
  const { settings, ai, store } = await setup()
  const provider = await settings.saveProvider(providerInput)
  const model = await settings.saveModel({ ...modelInput, providerId: provider.id })
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'示例','direct',0)")
  const thread = await ai.openThread('1')
  const turn = await ai.createTurn({ threadId: thread.id, requestId: 'test', prompt: '示例问题', referenceIds: [], modelId: model.id })
  await expect(settings.removeModel(model.id)).rejects.toMatchObject({ code: 'MODEL_BUSY' })
  expect(settings.get().models).toHaveLength(1)
  await ai.saveTurn(turn.id, { state: 'completed', text: '示例结果' })
  const before = settings.get()
  store.writer.exec("CREATE TRIGGER settings_write_failure BEFORE INSERT ON ai_model_versions BEGIN SELECT RAISE(ABORT,'disk unavailable'); END")
  await expect(settings.saveProvider({ ...providerInput, id: provider.id, enabled: false })).rejects.toThrow()
  expect(settings.get()).toEqual(before)
  store.writer.exec('DROP TRIGGER settings_write_failure')
  await settings.removeProvider(provider.id)
  expect(ai.getThread(thread.id).turns[0].text).toBe('示例结果')
})

test('analysis processing is pinned per task and removed with its conversation', async () => {
  const { settings, ai, store } = await setup()
  const provider = await settings.saveProvider(providerInput), model = await settings.saveModel({ ...modelInput, providerId: provider.id })
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'示例','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(1,1,1,'member','本人','text','示例正文',0,1234)`)
  const prepared = await ai.prepareAnalysis({ conversationId: '1', modelId: model.id }), task = await ai.confirmAnalysis({ token: prepared.token, requestId: 'analysis' })
  expect(ai.analysisContext(task.id).messages[0]).toMatchObject({ sentAtMs: 1234, memberId: '1' })
  await settings.claimProcessing(task.id, 'first-processing')
  await settings.claimProcessing(task.id, 'first-processing')
  await expect(settings.claimProcessing(task.id, 'different-processing')).rejects.toMatchObject({ code: 'PROCESSING_CHANGED' })
  await expect(settings.claimProcessing('999', 'first-processing')).rejects.toMatchObject({ code: 'INVALID_TASK' })
  await ai.commitBatch(task.id, { index: 0, messageIds: ['1'], report: { summary: '示例结果', observations: [{ text: '示例观察', evidenceMessageIds: ['1'], limitations: '示例范围' }], limitations: '示例范围' }, usage: {} })
  store.writer.prepare('DELETE FROM settings_analysis_processing WHERE task_id=?').run(BigInt(task.id))
  await expect(settings.claimProcessing(task.id, 'new-version')).rejects.toMatchObject({ code: 'PROCESSING_CHANGED' })
  purgeConversation(store, '1')
  expect(store.reader.prepare('SELECT count(*) n FROM settings_analysis_processing').get()).toMatchObject({ n: 0n })
})

test('provider toggles retain independent model toggles and last selection without selecting an alternative', async () => {
  const { settings, ai } = await setup()
  const provider = await settings.saveProvider(providerInput)
  const active = await settings.saveModel({ ...modelInput, providerId: provider.id })
  const disabled = await settings.saveModel({ ...modelInput, providerId: provider.id, model: 'disabled', enabled: false })
  await settings.selectModel('analysis', active.id)
  await settings.saveProvider({ ...providerInput, id: provider.id, enabled: false })
  expect(ai.listModels().filter(value => value.enabled)).toEqual([])
  expect(settings.get().selectedModels.analysis).toBe(active.id)
  await settings.saveProvider({ ...providerInput, id: provider.id, enabled: true })
  expect(ai.modelSecret(active.id).model.enabled).toBe(true)
  expect(ai.modelSecret(disabled.id).model.enabled).toBe(false)
  await expect(ai.saveModel({ ...ai.modelSecret(active.id).model, enabled: false })).rejects.toMatchObject({ code: 'SETTINGS_REQUIRED' })
  await settings.removeModel(active.id)
  await expect(ai.saveModel({ ...ai.modelSecret(active.id).model, enabled: true })).rejects.toMatchObject({ code: 'SETTINGS_REQUIRED' })
  expect(ai.modelSecret(active.id).model.enabled).toBe(false)
})

test('provider images accept only bounded local raster data and cannot discard saved configuration on failure', async () => {
  const { settings } = await setup()
  const provider = await settings.saveProvider({ ...providerInput, image: 'data:image/png;base64,aW1hZ2U=' })
  const before = settings.get()
  for (const image of ['https://example.test/image.png', 'data:image/svg+xml;base64,aW1hZ2U=', `data:image/png;base64,${Buffer.alloc(1048577).toString('base64')}`]) {
    expect(await settings.saveProvider({ ...providerInput, id: provider.id, image }).then(() => 'saved', error => error.code)).toBe('INVALID_PROVIDER')
  }
  expect(settings.get()).toEqual(before)
})
