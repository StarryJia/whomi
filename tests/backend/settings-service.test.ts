import { afterEach, expect, test, vi } from 'vitest'
import { createServer } from 'node:http'
import { createSettingsService } from '../../electron/main/settings-service'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiRepository } from '../../electron/data/ai/repository'
import { openStore } from '../../electron/data/db/open'
import { temporaryStore } from './helpers'

const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close() })
async function setup(fetcher?: typeof fetch, beforeModelChange = async (_ids: string[]) => {}) {
  const temp = temporaryStore(), store = openStore(temp.path); cleanup.push(() => { store.close(); temp.cleanup() })
  const repository = createSettingsRepository(store, async operation => operation()); await repository.initialize()
  const service = createSettingsService({ storage: async (method, args) => (repository[method as keyof typeof repository] as (...values: unknown[]) => unknown)(...args), secrets: { encrypt: value => `encrypted:${value}`, decrypt: value => value.slice('encrypted:'.length) }, testModel: async () => {}, beforeModelChange, fetch: fetcher })
  return { repository, service, store }
}
const providerInput = { name: '示例服务', baseUrl: 'http://127.0.0.1:1234/v1/', enabled: true }

test('catalog preserves bounded model metadata without copying untrusted credential fields', async () => {
  const { service } = await setup(async () => Response.json({ data: [{ id: 'alpha', name: '示例模型', context_length: 200000, max_output_tokens: 32768, max_input_tokens: 180000, group: '示例组', api_key: 'never-copy' }] }))
  const provider = await service.saveProvider(providerInput)
  expect(await service.syncModels(provider.id)).toEqual([{ id: 'alpha', label: '示例模型', contextWindow: 200000, maxTokens: 32768, maxInputTokens: 180000, group: '示例组' }])
})

test('sync fills missing limits on a saved model and keeps its manual output limit', async () => {
  const { service } = await setup(async () => Response.json({ data: [{ id: 'alpha', context_length: 32000, max_input_tokens: 28000, max_output_tokens: 4000 }] }))
  const provider = await service.saveProvider(providerInput)
  await service.saveModel({ providerId: provider.id, model: 'alpha', label: '示例', contextWindow: null, maxTokens: 2048, enabled: true })
  await service.syncModels(provider.id)
  const [saved] = (await service.get()).models
  expect(saved).toMatchObject({ contextWindow: 32000, maxInputTokens: 28000, maxTokens: 2048 })
  await service.syncModels(provider.id)
  expect((await service.get()).models[0].version).toBe(saved.version)
  const rename = { id: saved.id, providerId: provider.id, model: 'alpha', label: '同步后改名', enabled: true }
  expect(await service.saveModel(rename)).toMatchObject({ contextWindow: 32000, maxInputTokens: 28000, maxTokens: 2048 })
  expect(await service.saveModel({ ...rename, contextWindow: null })).toMatchObject({ contextWindow: null, maxInputTokens: 28000, maxTokens: 2048 })
})

test.each(['capacity', 'credential'])('a paused insight keeps its frozen model across catalog synchronization but rejects a manual %s change', async change => {
  let catalog = { id: 'alpha', context_length: 32000, max_input_tokens: undefined as number | undefined }
  const { service, store } = await setup(async () => Response.json({ data: [catalog] }))
  const ai = createAiRepository(store, async operation => operation())
  const provider = await service.saveProvider({ ...providerInput, apiKey: 'sample-one' })
  const input = { providerId: provider.id, model: 'alpha', label: '示例', contextWindow: null, maxTokens: 2048, enabled: true }
  const frozen = await service.saveModel(input)
  store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'示例','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','示例正文',0)`)
  const prepared = await ai.prepareAnalysis({ conversationId: '1', modelId: frozen.id })
  const task = await ai.confirmAnalysis({ token: prepared.token, requestId: 'resume-after-sync' })
  await ai.saveInsightCheckpoint(task.id, 'saved-position', ['1'], 50)
  await ai.saveAnalysis(task.id, { state: 'stopped' })
  await service.syncModels(provider.id)
  catalog = { ...catalog, max_input_tokens: 28000 }
  await service.syncModels(provider.id)

  expect((await service.get()).models[0]).toMatchObject({ version: frozen.version + 2, contextWindow: 32000, maxInputTokens: 28000 })
  await expect(ai.resumeAnalysis(task.id)).resolves.toMatchObject({ id: task.id, analyzedMessages: 1 })
  expect(ai.analysisContext(task.id)).toMatchObject({ model: { version: frozen.version, contextWindow: null }, checkpoint: 'saved-position' })

  await ai.saveAnalysis(task.id, { state: 'stopped' })
  if (change === 'capacity') await service.saveModel({ ...input, id: frozen.id, contextWindow: 48000 })
  else await service.saveProvider({ ...providerInput, id: provider.id, apiKey: 'sample-two' })
  await service.syncModels(provider.id)
  await expect(ai.resumeAnalysis(task.id)).rejects.toMatchObject({ code: 'MODEL_CHANGED' })
})

test('sync reads only the saved endpoint with its credential and never persists unselected models', async () => {
  let observed: { url: string; headers: Headers; redirect: RequestRedirect | undefined } | undefined
  const { service, repository } = await setup(async (url, init) => { observed = { url: String(url), headers: new Headers(init?.headers), redirect: init?.redirect }; return Response.json({ data: [{ id: 'example-model', api_key: 'server-secret' }, { id: 'example-model' }, { id: 'other-model' }] }) })
  const provider = await service.saveProvider({ ...providerInput, apiKey: 'sample-key' })
  expect(provider).toMatchObject({ hasCredential: true })
  expect(JSON.stringify(await service.get())).not.toContain('sample-key')
  expect(repository.providerSecret(provider.id).encryptedKey).toBe('encrypted:sample-key')
  expect(await service.syncModels(provider.id)).toEqual([{ id: 'example-model' }, { id: 'other-model' }])
  expect(observed).toMatchObject({ url: 'http://127.0.0.1:1234/v1/models', redirect: 'error' })
  expect(observed!.headers.get('Authorization')).toBe('Bearer sample-key')
  expect((await service.get()).models).toEqual([])
})

test('sync rejects redirects, oversized bodies and invalid catalogs without losing saved settings', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://elsewhere.test' } }), new Response('{}', { headers: { 'content-length': '1048577' } }), Response.json({ data: [{ id: 'x'.repeat(129) }] }), new Response('invalid json')]) {
    const { service } = await setup(async () => response)
    const provider = await service.saveProvider(providerInput), before = await service.get()
    await expect(service.syncModels(provider.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(await service.get()).toEqual(before)
  }
})

test('an active runtime blocks provider deletion without discarding configuration', async () => {
  const { service } = await setup(undefined, async ids => { if (ids.length) throw new Error('请停止任务后重试。') })
  const provider = await service.saveProvider(providerInput)
  await service.saveModel({ providerId: provider.id, label: '示例', model: 'example', contextWindow: 4096, maxTokens: 512, enabled: true })
  await expect(service.removeProvider(provider.id)).rejects.toThrow('请停止任务后重试。')
  expect((await service.get()).providers).toHaveLength(1)
})

test('rejected catalogs cancel response bodies before returning an error', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const { service } = await setup(async () => new Response(body, { status: 503 }))
  const provider = await service.saveProvider(providerInput)
  await expect(service.syncModels(provider.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
  expect(cancelled).toBe(true)
})

test('streamed response limits and timeout reject without returning server content or credentials', async () => {
  const { service } = await setup(async () => new Response(new Uint8Array(1048577)))
  const provider = await service.saveProvider(providerInput)
  await expect(service.syncModels(provider.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
  vi.useFakeTimers()
  const slow = await setup(async (_url, init) => new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('server-secret sample-key'))) }))
  const saved = await slow.service.saveProvider({ ...providerInput, apiKey: 'sample-key' })
  const pending = slow.service.syncModels(saved.id)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED', action: expect.not.stringContaining('sample-key') })
  await vi.advanceTimersByTimeAsync(10000)
  await rejected
})

test('real catalog fetch honors a saved custom path and refuses to forward credentials across redirects', async () => {
  let leaked = false
  const server = createServer((request, response) => {
    if (request.url === '/saved/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'local-example' }] })) }
    else if (request.url === '/redirect/models') { response.writeHead(302, { location: '/elsewhere' }); response.end() }
    else { leaked = true; response.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const { service } = await setup()
    const saved = await service.saveProvider({ ...providerInput, baseUrl: `http://127.0.0.1:${port}/saved`, apiKey: 'sample-key' })
    expect(await service.syncModels(saved.id)).toEqual([{ id: 'local-example' }])
    await service.saveProvider({ ...providerInput, id: saved.id, baseUrl: `http://127.0.0.1:${port}/redirect` })
    await expect(service.syncModels(saved.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(leaked).toBe(false)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('subscription usage is read only for a connected account and a switch invalidates an in-flight result', async () => {
  const storage = vi.fn(async () => ({ requests:1, inputTokens:12, outputTokens:3, partial:false }))
  const getStatus = vi.fn()
  const service = createSettingsService({ storage, secrets:{encrypt:String, decrypt:String}, testModel:async()=>{}, beforeModelChange:async()=>{},
    accounts:{'openai-codex':{getStatus, signIn:vi.fn(), cancel:vi.fn(), signOut:vi.fn(), listModels:vi.fn()}} })
  getStatus.mockResolvedValueOnce({state:'disconnected'})
  await expect(service.getAccountUsage('openai-codex')).rejects.toMatchObject({code:'ACCOUNT_LOGIN'})
  expect(storage).not.toHaveBeenCalled()
  getStatus.mockResolvedValueOnce({state:'connected',accountId:'a'}).mockResolvedValueOnce({state:'connected',accountId:'b'})
  await expect(service.getAccountUsage('openai-codex')).rejects.toMatchObject({code:'ACCOUNT_CHANGED'})
  expect(storage).toHaveBeenCalledWith('accountUsage',['openai-codex','a'])
})
