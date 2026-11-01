import { afterEach, expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { temporaryStore } from './helpers'
import { defaultProcessing, presetAccountId } from '../../src/shared/settings-contract'
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

test('custom provider retains each endpoint and built-in logo, rerouting only when its default changes', async () => {
  const { settings, ai } = await setup()
  const original = await settings.saveProvider(providerInput, 'encrypted-original')
  const model = await settings.saveModel({ ...modelInput, providerId: original.id })
  const add = { ...providerInput, id: original.id, avatarId: 'deepseek', endpointUrls: {
    'openai-completions': providerInput.baseUrl, 'anthropic-messages': 'https://anthropic.example'
  } }
  const updated = await settings.saveProvider(add)
  expect(updated).toMatchObject({ avatarId: 'deepseek', endpointUrls: add.endpointUrls, hasCredential: true })
  expect(settings.get().models[0].version).toBe(model.version)
  await settings.saveProvider({ ...add, baseUrl: add.endpointUrls['anthropic-messages'], protocol: 'anthropic-messages' })
  expect(ai.modelSecret(model.id).model).toMatchObject({ protocol: 'anthropic-messages', baseUrl: 'https://anthropic.example' })
  expect(ai.modelSecret(model.id, model.version).model).toMatchObject({ baseUrl: providerInput.baseUrl })
  await expect(settings.saveProvider({ ...add, endpointUrls: { ...add.endpointUrls, 'google-generative-ai': 'file:///invalid' } })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  await expect(settings.saveProvider({ ...add, avatarId: '../invalid' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  expect(settings.providerSecret(original.id).encryptedKey).toBe('encrypted-original')
})

test('configuring a preset preserves same-name accounts and model choices across restart', async () => {
  const { settings, store, temp, write } = await setup()
  const custom = await settings.saveProvider(providerInput, 'custom-secret')
  const model = await settings.saveModel({ ...modelInput, providerId: custom.id })
  await settings.selectModel('conversation', model.id)

  const preset = await settings.saveProvider({ ...providerInput, presetId: 'openai' }, 'preset-secret')
  expect(preset.id).toBe(presetAccountId('openai'))
  expect(preset.id).not.toBe(custom.id)
  store.close()
  const reopened = openStore(temp.path)
  cleanup.push(() => reopened.close())
  const fresh = createSettingsRepository(reopened, write)
  await fresh.initialize()
  expect(fresh.get().providers).toHaveLength(2)
  expect(fresh.get().selectedModels.conversation).toBe(model.id)
  expect(fresh.get().models.map(item => item.id)).toEqual([model.id])
  expect(JSON.stringify(fresh.get())).not.toContain('-secret')

  await fresh.saveProvider({ ...providerInput, id: preset.id, name: '改名后' })
  expect(fresh.providerSecret(preset.id).encryptedKey).toBe('preset-secret')
  await fresh.removeProvider(preset.id)
  expect(fresh.get().providers.map(item => item.id)).toEqual([custom.id])
  expect(fresh.providerSecret(custom.id).encryptedKey).toBe('custom-secret')
  const recreated = await fresh.saveProvider({ ...providerInput, presetId: 'openai' })
  expect(recreated).toMatchObject({ id: preset.id, hasCredential: false })
})

test('duplicate preset activation cannot overwrite a saved endpoint or key', async () => {
  const { settings } = await setup()
  const input = { ...providerInput, presetId: 'openai' }
  const [first, stale] = await Promise.allSettled([
    settings.saveProvider(input, 'first-key'),
    settings.saveProvider({ ...input, baseUrl: 'https://other.example/v1' }, 'stale-key'),
  ])
  expect(first.status).toBe('fulfilled')
  expect(stale).toMatchObject({ status: 'rejected', reason: { code: 'DUPLICATE_PROVIDER' } })
  const id = presetAccountId(input.presetId)
  await expect(settings.saveProvider({ ...input, id })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  await expect(settings.saveProvider({ ...input, presetId: 'not-a-cherry-preset' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  await expect(settings.saveProvider({ ...input, presetId: 'comfyui', protocol: 'openai-completions' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  expect(settings.get().providers).toHaveLength(1)
  expect(settings.providerSecret(id)).toMatchObject({ provider: { baseUrl: input.baseUrl }, encryptedKey: 'first-key' })
})

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
  await ai.commitBatch(task.id, { index: 0, messageIds: ['1'], report: { events: [{ key: '示例', text: '示例观察', evidenceMessageIds: ['1'], signals: [] }] }, usage: {} })
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


test('subscription models keep their account and version on refresh, and reject editing the authorization endpoint', async () => {
  const { settings, ai } = await setup()
  const providerId = 'cherry:openai-codex'
  await expect(settings.saveProvider({ ...providerInput, presetId: 'openai-codex' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  await settings.setAccountConnection('openai-codex', 'account-one', true)
  const model = await settings.saveModel({ ...modelInput, providerId })
  expect(ai.modelSecret(model.id).model).toMatchObject({ baseUrl: 'https://api.openai.com/v1', planAccount: 'account-one' })
  expect(ai.modelSecret(model.id).encryptedKey).toBeNull()
  await settings.setAccountConnection('openai-codex', 'account-one')
  expect(ai.modelSecret(model.id).model.version).toBe(model.version)
  await expect(settings.saveProvider({ ...providerInput, id: providerId })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  await settings.setAccountConnection('openai-codex', null)
  expect(ai.modelSecret(model.id).model.enabled).toBe(false)
  await settings.setAccountConnection('openai-codex', 'account-two', true)
  expect(ai.modelSecret(model.id).model).toMatchObject({ enabled: true, planAccount: 'account-two' })
  expect(ai.modelSecret(model.id, model.version).model.planAccount).toBe('account-one')
})


test('other subscription accounts retain independent bindings and never accept custom hosts', async () => {
  const { settings, ai } = await setup()
  for (const [id, host] of [['grok-cli', 'https://cli-chat-proxy.grok.com/v1'], ['copilot', 'https://api.githubcopilot.com']] as const) {
    await settings.setAccountConnection(id, 'bound-' + id, true)
    const m = await settings.saveModel({ ...modelInput, providerId: 'cherry:' + id })
    expect(ai.modelSecret(m.id).model).toMatchObject({ baseUrl: host, planProvider: id, planAccount: 'bound-' + id })
    await expect(settings.saveProvider({ ...providerInput, id: 'cherry:' + id })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  }
  await settings.setAccountConnection('grok-cli', null)
  expect(settings.get().providers.find(p => p.id === 'cherry:copilot')?.enabled).toBe(true)
})

test('reauthorizing the original account resumes its saved task; a replacement account cannot', async () => {
  const { settings, ai, store } = await setup()
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'读书','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'test','test');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','翻到下一页',0)`)
  await settings.setAccountConnection('openai-codex', 'account-one', true)
  const model = await settings.saveModel({ ...modelInput, providerId: 'cherry:openai-codex' })
  const prep = await ai.prepareAnalysis({ conversationId: '1', modelId: model.id })
  const task = await ai.confirmAnalysis({ token: prep.token, requestId: 'resume-reauth' })
  await ai.saveAnalysis(task.id, { state: 'stopped' })
  await settings.setAccountConnection('openai-codex', null)
  await settings.setAccountConnection('openai-codex', 'account-two', true)
  await expect(ai.resumeAnalysis(task.id)).rejects.toMatchObject({ code: 'MODEL_CHANGED' })
  await settings.setAccountConnection('openai-codex', null)
  await settings.setAccountConnection('openai-codex', 'account-one', true)
  expect((await ai.resumeAnalysis(task.id)).id).toBe(task.id)
})

test('local subscription usage follows the original account/model version and never fills missing counters', async () => {
  const { store, settings, ai } = await setup()
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'用量测试','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','usage');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','虚构',0)`)
  const provider = 'openai-codex'
  await settings.setAccountConnection(provider, 'account-a', true)
  const model = await settings.saveModel({ ...modelInput, providerId: presetAccountId(provider) })
  const thread = await ai.createThread('1')
  const turn = await ai.createTurn({ threadId: thread.id, requestId: 'a', prompt: '虚构', referenceIds: [], modelId: model.id })
  await ai.recordUsage({ ownerKind: 'turn', ownerId: turn.id, requestId: 'first', usage: { incomplete: true } })
  await ai.recordUsage({ ownerKind: 'turn', ownerId: turn.id, requestId: 'first', usage: { totalInputTokens: 20, inputTokens: 15, cacheReadTokens: 5, outputTokens: 0 } })
  await ai.saveTurn(turn.id, { state: 'completed', text: '虚构' })
  const prep = await ai.prepareAnalysis({ conversationId:'1', modelId:model.id })
  const task = await ai.confirmAnalysis({token:prep.token,requestId:'analysis-a'})
  await ai.recordUsage({ ownerKind:'analysis', ownerId:task.id, requestId:'second', usage:{ outputTokens:3, incomplete:true } })
  await ai.saveAnalysis(task.id, { state:'stopped' })
  await settings.setAccountConnection(provider, 'account-b', true)
  const later = await ai.createTurn({ threadId:thread.id, requestId:'b', prompt:'虚构', referenceIds:[], modelId:model.id })
  await ai.recordUsage({ownerKind:'turn', ownerId:later.id, requestId:'b1', usage:{totalInputTokens:0,outputTokens:0}})
  expect(settings.accountUsage(provider,'account-a')).toEqual({requests:2, inputTokens:20, outputTokens:3, partial:true})
  expect(settings.accountUsage(provider,'account-b')).toEqual({requests:1, inputTokens:0, outputTokens:0, partial:false})
  expect(settings.accountUsage('grok-cli','account-a')).toEqual({requests:0,inputTokens:null,outputTokens:null,partial:false})
  await ai.recordUsage({ownerKind:'turn', ownerId:later.id, requestId:'b1', usage:{incomplete:true}})
  expect(settings.accountUsage(provider,'account-b')).toEqual({requests:1,inputTokens:null,outputTokens:null,partial:true})
  store.writer.prepare("UPDATE ai_model_versions SET data=json_remove(data,'$.planProvider') WHERE model_id=? AND version=1").run(model.id)
  expect(settings.accountUsage(provider,'account-a')).toEqual({requests:0,inputTokens:null,outputTokens:null,partial:false})

})
