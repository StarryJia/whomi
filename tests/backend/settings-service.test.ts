import { afterEach, expect, test, vi } from 'vitest'
import { createServer } from 'node:http'
import { createSettingsService } from '../../electron/main/settings-service'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { openStore } from '../../electron/data/db/open'
import { temporaryStore } from './helpers'

const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close() })
async function setup(fetcher?: typeof fetch, beforeModelChange = async (_ids: string[]) => {}) {
  const temp = temporaryStore(), store = openStore(temp.path); cleanup.push(() => { store.close(); temp.cleanup() })
  const repository = createSettingsRepository(store, async operation => operation()); await repository.initialize()
  const service = createSettingsService({ storage: async (method, args) => (repository[method as keyof typeof repository] as (...values: unknown[]) => unknown)(...args), secrets: { encrypt: value => `encrypted:${value}`, decrypt: value => value.slice('encrypted:'.length) }, testModel: async () => {}, beforeModelChange, fetch: fetcher })
  return { repository, service }
}
const providerInput = { name: '示例服务', baseUrl: 'http://127.0.0.1:1234/v1/', enabled: true }

test('catalog preserves bounded model metadata without copying untrusted credential fields', async () => {
  const { service } = await setup(async () => Response.json({ data: [{ id: 'alpha', name: '示例模型', context_length: 200000, max_output_tokens: 32768, max_input_tokens: 180000, group: '示例组', api_key: 'never-copy' }] }))
  const provider = await service.saveProvider(providerInput)
  expect(await service.syncModels(provider.id)).toEqual([{ id: 'alpha', label: '示例模型', contextWindow: 200000, maxTokens: 32768, maxInputTokens: 180000, group: '示例组' }])
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
