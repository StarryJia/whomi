import { afterEach, beforeAll, expect, test } from 'vitest'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { createSettingsService } from '../../electron/main/settings-service'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiRepository } from '../../electron/data/ai/repository'
import { openStore } from '../../electron/data/db/open'
import { temporaryStore } from './helpers'
import type { AiModel } from '../../src/shared/ai-contract'
import type { ProviderInput } from '../../src/shared/settings-contract'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
beforeAll(async () => { await import('@earendil-works/pi-coding-agent') }, 30000)
async function setup() {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanups.push(() => { store.close(); temp.cleanup() })
  const repository = createSettingsRepository(store, async operation => operation()), ai = createAiRepository(store, async operation => operation())
  await repository.initialize()
  const service = createSettingsService({ storage: async (method, args) => (repository[method as keyof typeof repository] as (...args: unknown[]) => unknown)(...args), secrets: { encrypt: value => `encrypted:${value}`, decrypt: value => value.slice(10) }, testModel: async () => {}, beforeModelChange: async () => {} })
  return { service, repository, ai, store, directory: dirname(temp.path) }
}
type Request = { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }
async function server(handler: (request: Request, response: ServerResponse) => void) {
  const requests: Request[] = []
  const instance = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => { const request = { path: req.url!, headers: req.headers, body: body ? JSON.parse(body) : {} }; requests.push(request); handler(request, res) }) })
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())) })
  return { base: `http://127.0.0.1:${(instance.address() as { port: number }).port}`, requests }
}
function events(response: ServerResponse, values: Record<string, unknown>[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const value of values) response.write(`${value.type ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`)
  response.end()
}
const cases = [
  { protocol: 'openai-completions', prefix: '/v1', path: '/v1/chat/completions', header: 'authorization', credential: 'Bearer !literal-$key', body: 'messages', events: [{ choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }] },
  { protocol: 'openai-responses', prefix: '/v1', path: '/v1/responses', header: 'authorization', credential: 'Bearer !literal-$key', body: 'input', events: [{ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_example', type: 'message', role: 'assistant', content: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '收到' }, { type: 'response.completed', response: { id: 'resp_example', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } }] },
  { protocol: 'anthropic-messages', prefix: '/v1', path: '/v1/messages', header: 'x-api-key', credential: '!literal-$key', body: 'messages', events: [{ type: 'message_start', message: { id: 'msg_example', type: 'message', role: 'assistant', model: 'example-model', content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }] },
  { protocol: 'google-generative-ai', prefix: '/v1beta', path: '/v1beta/models/example-model:streamGenerateContent?alt=sse', header: 'x-goog-api-key', credential: '!literal-$key', body: 'contents', events: [{ candidates: [{ content: { role: 'model', parts: [{ text: '收到' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, cachedContentTokenCount: 2, totalTokenCount: 15 } }] },
]

test.each(cases)('$protocol sends its native request and reports actual usage', async fixture => {
  const { directory } = await setup()
  const http = await server((request, response) => {
    if (request.path !== fixture.path && !(fixture.protocol === 'anthropic-messages' && request.path === `${fixture.path}?beta=true`)) { response.writeHead(400); response.end('{}'); return }
    events(response, fixture.events)
  })
  const model = { id: 'example', label: '示例模型', model: 'example-model', protocol: fixture.protocol, baseUrl: http.base + fixture.prefix, contextWindow: 32000, maxTokens: 1000, version: 1, enabled: true, hasCredential: true } as AiModel
  const result = await new PiRuntime(directory).run({ key: fixture.protocol, model, apiKey: '!literal-$key', systemPrompt: '示例系统提示', prompt: '示例问题' }, { signal: AbortSignal.timeout(10000), onText() {} }).catch(error => { throw new Error(`${error.message}; requested ${http.requests.map(request => request.path).join(',')}`) })
  expect(result.text).toBe('收到')
  expect(http.requests).toHaveLength(1)
  expect(http.requests[0].headers[fixture.header]).toBe(fixture.credential)
  expect(JSON.stringify(http.requests[0].body[fixture.body])).toContain('示例问题')
  expect(result.usage).toMatchObject({ inputTokens: 10, totalInputTokens: 12, outputTokens: 3, cacheReadTokens: 2, incomplete: false })
}, 20000)

test('legacy root catalog endpoints retain their saved address without adding an API version', async () => {
  const http = await server((request, response) => {
    if (request.path !== '/models') { response.writeHead(404); response.end('{}'); return }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'legacy-model' }] }))
  })
  const { service, store } = await setup()
  const provider = await service.saveProvider({ name: '旧本地服务', baseUrl: http.base, enabled: true })
  store.writer.prepare("UPDATE settings_providers SET data=json_remove(data,'$.protocol') WHERE id=?").run(provider.id)
  expect(await service.syncModels(provider.id)).toEqual([{ id: 'legacy-model' }])
  expect(http.requests.map(request => request.path)).toEqual(['/models'])
  expect((await service.get()).providers[0].baseUrl).toBe(http.base)
})

test.each([undefined, 'openai-completions', 'openai-responses', 'google-generative-ai'])('root runtime address remains exact for protocol %s', async protocol => {
  const fixture = cases.find(item => item.protocol === (protocol ?? 'openai-completions'))!
  const expectedPath = fixture.path.slice(fixture.prefix.length)
  const http = await server((request, response) => {
    if (request.path !== expectedPath) { response.writeHead(404); response.end('{}'); return }
    events(response, fixture.events)
  })
  const { directory } = await setup()
  const model = { id: 'legacy', label: '旧本地模型', model: 'example-model', baseUrl: http.base, ...(protocol ? { protocol } : {}), contextWindow: 32000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false } as AiModel
  const result = await new PiRuntime(directory).run({ key: 'root-model', model, systemPrompt: '示例系统提示', prompt: '示例问题' }, { signal: AbortSignal.timeout(10000), onText() {} })
  expect(result.text).toBe('收到')
  expect(http.requests.map(request => request.path)).toEqual([expectedPath])
  expect(model.baseUrl).toBe(http.base)
}, 20000)

test.each(['openai-responses', 'anthropic-messages', 'google-generative-ai'])('%s catalog uses its saved protocol and follows native pagination', async protocol => {
  const http = await server((request, response) => {
    const url = new URL(request.path, 'http://example.test')
    response.setHeader('content-type', 'application/json')
    if (protocol === 'google-generative-ai') {
      if (url.pathname !== '/v1beta/models' || request.headers['x-goog-api-key'] !== 'sample-key') { response.writeHead(401); response.end('{}'); return }
      response.end(JSON.stringify(url.searchParams.has('pageToken') ? { models: [{ name: 'models/second', displayName: '第二个', supportedGenerationMethods: ['generateContent'] }] } : { models: [{ name: 'models/first', displayName: '第一个', inputTokenLimit: 32000, outputTokenLimit: 4000, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next-page' }))
    } else if (protocol === 'anthropic-messages') {
      if (url.pathname !== '/v1/models' || request.headers['x-api-key'] !== 'sample-key' || request.headers['anthropic-version'] !== '2023-06-01') { response.writeHead(401); response.end('{}'); return }
      response.end(JSON.stringify(url.searchParams.has('after_id') ? { data: [{ id: 'second', display_name: '第二个' }], has_more: false } : { data: [{ id: 'first', display_name: '第一个' }], has_more: true, last_id: 'first' }))
    } else response.end(JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }] }))
  })
  const { service } = await setup()
  const provider = await service.saveProvider({ name: '示例服务', enabled: true, protocol, baseUrl: http.base + (protocol === 'google-generative-ai' ? '/v1beta' : '/v1'), apiKey: 'sample-key' } as ProviderInput)
  expect((await service.syncModels(provider.id)).map(model => model.id)).toEqual(['first', 'second'])
  if (protocol !== 'openai-responses') expect(http.requests).toHaveLength(2)
  expect((await service.get()).models).toEqual([])
})

test('protocol changes create new model versions while legacy snapshots keep their original protocol and encrypted secret', async () => {
  const { service, ai, repository, store } = await setup()
  const provider = await service.saveProvider({ name: '示例服务', enabled: true, baseUrl: 'https://example.test/v1', apiKey: '!literal-$key' })
  const model = await service.saveModel({ providerId: provider.id, label: '示例模型', model: 'example', enabled: true, contextWindow: 32000, maxTokens: 1000 })
  await service.saveProvider({ id: provider.id, name: '示例服务', enabled: true, protocol: 'anthropic-messages', baseUrl: provider.baseUrl } as ProviderInput)
  expect(ai.modelSecret(model.id).model).toMatchObject({ protocol: 'anthropic-messages', version: 2 })
  expect(ai.modelSecret(model.id, 1).model).toMatchObject({ protocol: 'openai-completions', version: 1 })
  expect(repository.providerSecret(provider.id).encryptedKey).toBe('encrypted:!literal-$key')
  expect(JSON.stringify(await service.get())).not.toContain('literal-$key')
  store.writer.prepare("UPDATE settings_providers SET data=json_remove(data,'$.protocol') WHERE id=?").run(provider.id)
  expect((await service.get()).providers[0]).toMatchObject({ protocol: 'openai-completions' })
  await expect(service.saveProvider({ id: provider.id, name: '示例服务', enabled: true, protocol: 'invented', baseUrl: provider.baseUrl } as unknown as ProviderInput)).rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
})

test.each(cases)('$protocol retains unknown usage, rejects service failures and cancels without committing a checkpoint', async fixture => {
  const { directory } = await setup()
  let mode: 'unknown' | 'failure' | 'cancel' = 'unknown'
  const http = await server((_request, response) => {
    if (mode === 'failure') { response.writeHead(401); response.end(JSON.stringify({ error: { message: 'SYNTHETIC_SERVER_SECRET' } })); return }
    const values = structuredClone(fixture.events) as Record<string, unknown>[]
    for (const value of values) {
      delete value.usage; delete value.usageMetadata
      if (value.message && typeof value.message === 'object') delete (value.message as Record<string, unknown>).usage
      if (value.response && typeof value.response === 'object') delete (value.response as Record<string, unknown>).usage
    }
    // Anthropic requires a usage object in message_start; an empty object reports no counters.
    if (fixture.protocol === 'anthropic-messages') (values[0].message as Record<string, unknown>).usage = {}
    events(response, values)
  })
  const model = { id: 'example', label: '示例模型', model: 'example-model', protocol: fixture.protocol, baseUrl: http.base + fixture.prefix, contextWindow: 32000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false } as AiModel
  const runtime = new PiRuntime(directory), input = { key: fixture.protocol, model, systemPrompt: '示例系统提示', prompt: '示例问题' }
  const result = await runtime.run(input, { signal: AbortSignal.timeout(10000), onText() {} })
  expect(result.text).toBe('收到')
  expect(result.usage).toMatchObject({ incomplete: true })
  expect(result.usage.inputTokens).toBeUndefined(); expect(result.usage.outputTokens).toBeUndefined()
  mode = 'failure'
  await expect(runtime.run(input, { signal: AbortSignal.timeout(10000), onText() {} })).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED', message: expect.not.stringContaining('SYNTHETIC_SERVER_SECRET') })
  expect(http.requests).toHaveLength(2)
  mode = 'cancel'
  const controller = new AbortController()
  const cancelled = runtime.run(input, { signal: controller.signal, onText: () => controller.abort() })
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  await expect(cancelled).rejects.not.toHaveProperty('checkpoint')
  expect(http.requests).toHaveLength(3)
}, 20000)

test('repeated native page cursors fail without returning a partial catalog or changing configuration', async () => {
  const http = await server((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ name: 'models/first' }], nextPageToken: 'same' })) })
  const { service } = await setup()
  const provider = await service.saveProvider({ name: '示例', baseUrl: `${http.base}/v1beta`, protocol: 'google-generative-ai', enabled: true })
  const before = await service.get()
  await expect(service.syncModels(provider.id)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
  expect(await service.get()).toEqual(before)
  expect(http.requests).toHaveLength(2)
  expect(http.requests[0].path).toBe('/v1beta/models')
})
