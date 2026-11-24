import { expect, test, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'
import { createAiService, type RuntimeRunner } from '../../electron/main/ai-service'
import { createChatgptRunner } from '../../electron/main/chatgpt-responses'
import { defaultProcessing } from '../../src/shared/settings-contract'
import type { AiModel, AnalysisTask } from '../../src/shared/ai-contract'
import { resolveModelLimits } from '../../src/shared/model-limits'
import { validateAiResult } from '../../src/shared/ai-validation'

test('洞察选择器和准备阶段沿用官方 Responses 支持的思考强度', async () => {
  const model = { id: '1', label: '示例', model: 'gpt-6.1-sol', protocol: 'openai-completions', baseUrl: 'https://api.openai.com/v1',
    version: 1, enabled: true, hasCredential: false, contextWindow: null, maxTokens: null } satisfies AiModel
  const storage = vi.fn(async (method: string, args: unknown[]) => {
    if (method === 'listModels') return [model]
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'prepareAnalysis') return args[0]
    throw Error(method)
  })
  const service = createAiService({ storage, runtime: { run: vi.fn() }, secrets: { encrypt: value => value, decrypt: value => value } })
  const models = await service.listModels()
  expect(() => validateAiResult('listModels', models)).not.toThrow()
  expect(models[0].insightThinkingLevels).toContain('high')
  expect(models[0].thinkingLevels).toBeUndefined()
  await service.prepareAnalysis({ conversationId: '1', modelId: '1', thinkingLevel: 'high' })
  expect(storage).toHaveBeenCalledWith('prepareAnalysis', [{ conversationId: '1', modelId: '1', thinkingLevel: 'high' }])
})

function captureDiagnostics() {
  return {
    begin: vi.fn(() => crypto.randomUUID()), bind: vi.fn(), findByTask: vi.fn(async () => null), resume: vi.fn(), discardUnstarted: vi.fn(),
    event: vi.fn((_id: string, _stage: string, _fields?: Record<string, unknown>) => {}), end: vi.fn(),
  }
}

test('同一洞察跨页保持会话，压缩与下一次推理之间优先处理连接检测，成稿等候落盘', async () => {
  let runs = 0, completed = false
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const order: string[] = []
  const task: AnalysisTask = { id: '1', conversationId: '1', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  const model = { id: 'm', label: '示例', model: 'm', planAccount: 'sample', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  const storage = async (method: string, args: unknown[]) => {
    if (method === 'prepareAnalysis') return { token: 'token', conversationId: '1', title: '示例', selfName: '我', totalMessages: 1, analyzableMessages: 1, snapshotMaxId: '1', expiresAt: Date.now() + 10000, model }
    if (method === 'confirmAnalysis' || method === 'getAnalysis') return { ...task }
    if (method === 'analysisContext') return { task, model, checkpoint: null, snapshot: { taskId: task.id, scope: { kind: 'all' }, sources: [{ messageId: '1', revision: 'r1' }] } }
    if (method === 'readInsightSources') return [{ id: '1', revision: 'r1', senderName: '我', isSelf: true, sentAtMs: 1000, text: '明天听你讲', replyToMessageId: null }]
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'saveAnalysis') { Object.assign(task, args[1]); return { ...task } }
    if (method === 'saveInsightCheckpoint') { task.analyzedMessages = (args[2] as string[]).length; return { ...task } }
    if (method === 'completeAnalysis') { completed = true; throw new Error('disk full') }
    if (method === 'recordUsage') return {}
    throw new Error(method)
  }
  const diagnostics = captureDiagnostics()
  let now = 0
  const insightAccountAccess = vi.fn(async () => ({ token: now < 120_000 ? 'example-first' : 'example-renewed', baseUrl: model.baseUrl }))
  const service = createAiService({ storage, diagnostics, insightAccountAccess, runtime: { run: async (_input, { insight }) => {
    if (!insight) { order.push('connection'); return { text: 'OK', usage: {}, checkpoint: '' } }
    runs++
    const first = await insight.record({ type: 'requestStart', kind: 'compaction', requestId: 'first' })
    expect(first?.access?.token).toBe('example-first')
    order.push('compaction')
    entered.resolve()
    await release.promise
    await insight.record({ type: 'request', kind: 'compaction', requestId: 'first', success: true, spans: [], usage: {}, checkpoint: 'summary' })
    const result = await insight!.read({}, 4000)
    expect(result.page.status).toBe('ok')
    const second = await insight.record({ type: 'requestStart', kind: 'inference', requestId: 'second' })
    expect(second?.access?.token).toBe('example-renewed')
    order.push('inference')
    await insight!.record({ type: 'request', kind: 'inference', requestId: 'second', success: true,
      spans: result.spans, usage: { outputTokens: 50 }, checkpoint: 'test-leaf' })
    const section = [{ content: [{ text: '明天听你讲', citationId: 'c1' }] }]
    return { text: JSON.stringify({ aboutYou: section, relationship: section, citations: [{ id: 'c1', fragments: [{ messageIds: ['1'] }] }], limitations: [], judgments: sampleJudgments() }),
      usage: {}, checkpoint: 'test-leaf' }
  } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  expect(runs).toBe(0)
  await service.confirmAnalysis({ token: 'token', requestId: 'same' })
  await service.confirmAnalysis({ token: 'token', requestId: 'same' })
  await entered.promise
  const connection = service.testModel('m')
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(order).toEqual(['compaction'])
  now = 300_000
  release.resolve()
  await connection
  await service.idle()
  expect(order).toEqual(['compaction', 'connection', 'inference'])
  expect(insightAccountAccess).toHaveBeenCalledTimes(2)
  expect(diagnostics.discardUnstarted).toHaveBeenCalledWith(diagnostics.begin.mock.results[1].value)
  const operation = diagnostics.begin.mock.results[0].value
  expect(diagnostics.event.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining(['reading', 'request', 'returned', 'saving']))
  expect(diagnostics.end).toHaveBeenCalledWith(operation, 'failed', expect.objectContaining({ phase: 'saving' }))
  expect(runs).toBe(1)
  expect(completed).toBe(true)
  expect(task.state).toBe('failed')
})

test('model credential encryption failure never sends or persists the secret', async () => {
  let saved = false
  const service = createAiService({ storage: async () => { saved = true }, runtime: { run: async () => { throw new Error('unexpected network') } }, secrets: { encrypt: () => { throw new Error('unavailable') }, decrypt: value => value } })
  await expect(service.saveModel({ id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, enabled: true, apiKey: 'test-secret' })).rejects.toThrow()
  expect(saved).toBe(false)
})

test('connection testing uses the saved encrypted credential without returning it to the page', async () => {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: true }
  let credential = ''
  const service = createAiService({ storage: async () => ({ model, encryptedKey: 'encrypted' }), runtime: { run: async input => { credential = input.apiKey ?? ''; return { text: 'OK', usage: {}, checkpoint: 'cp' } } }, secrets: { encrypt: value => value, decrypt: value => value === 'encrypted' ? 'test-key' : '' } })
  expect(await service.testModel('m')).toBeUndefined()
  expect(credential).toBe('test-key')
})

test('a failed model request is recorded as unknown usage instead of disappearing from task totals', async () => {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  const turn = { id: '1', threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm', text: '', state: 'queued', attempt: 1, usage: {}, eventSequence: 1 }
  const requests: any[] = []
  const service = createAiService({ storage: async (method, args) => {
    if (method === 'getThread') return { id: '1', conversationId: '1', turns: [turn] }
    if (method === 'createTurn') return turn
    if (method === 'turnContext') return { turn, conversationId: '1', model, selfFingerprint: 'self', references: [], history: [], profile: null, skill: null, checkpoint: null }
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'saveTurn') return Object.assign(turn, args[1])
    if (method === 'recordUsage') { requests.push(args[0]); return turn }
    throw new Error(method)
  }, runtime: { run: async () => { throw new Error('connection closed') } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(requests.some(value => value.requestId === '1:1' && value.usage.incomplete === true)).toBe(true)
  expect(turn.state).toBe('failed')
})

function turnStorage(model: AiModel = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }) {
  const turn = { id: '1', threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm', text: '', state: 'queued', attempt: 1, usage: {}, eventSequence: 1 }
  let identityChanged = false
  return { turn, changeIdentity() { identityChanged = true }, async storage(method: string, args: unknown[]) {
    if (method === 'getThread') return { id: '1', conversationId: '1', turns: [turn] }
    if (method === 'createTurn') return turn
    if (method === 'beginRetryTurn') { turn.attempt++; turn.state = 'queued'; return turn }
    if (method === 'turnContext') { if (identityChanged) throw new Error('identity changed'); return { turn, conversationId: '1', model, selfFingerprint: 'self', references: [], history: [], profile: null, skill: null, checkpoint: null } }
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'saveTurn') return Object.assign(turn, args[1])
    if (method === 'recordUsage') return turn
    throw new Error(method)
  } }
}
test.each([0, 47_000])('未知套餐模型为普通对话按剩余窗口请求输出，输入样本 %i 个汉字', async characters => {
  const state = turnStorage({ id: 'm', label: '示例', model: 'unknown', baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses', planProvider: 'openai-codex', planAccount: 'test', contextWindow: null, maxTokens: null,
    version: 1, enabled: true, hasCredential: false })
  state.turn.prompt = '文'.repeat(characters) + '继续'
  let outputLimit: number | undefined
  const runtime = createChatgptRunner(async () => 'synthetic', async (_url, init) => {
    outputLimit = JSON.parse(String(init?.body)).max_output_tokens
    const events = [{ type: 'response.output_text.delta', delta: '完成' }, { type: 'response.completed', response: { status: 'completed' } }]
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  const service = createAiService({ storage: state.storage, runtime, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: state.turn.prompt, referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(state.turn.state).toBe('completed')
  if (characters === 0) expect(outputLimit).toBe(128_000)
  else {
    expect(outputLimit).toBeGreaterThan(112_000)
    expect(outputLimit).toBeLessThanOrEqual(115_000)
  }
})
test.each([[null, 65536], [200000, 200000]] as const)('DeepSeek 普通对话在输出配置为 %s 时采用相应的请求额度', async (configuredOutput, expected) => {
  const state = turnStorage({ id: 'm', label: '示例', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai-completions', contextWindow: null, maxTokens: configuredOutput, version: 1, enabled: true, hasCredential: false })
  const run = vi.fn<RuntimeRunner['run']>(async () => ({ text: '收到', usage: {}, checkpoint: '' }))
  const service = createAiService({ storage: state.storage, runtime: { run }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '继续', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(run.mock.calls[0][0].outputTokenLimit).toBe(expected)
})

test.each(['send', 'confirm'] as const)('records %s before the database acknowledges the action and captures preparation failures', async action => {
  const diagnostics = captureDiagnostics()
  const storageEntered = Promise.withResolvers<void>()
  const acknowledgement = Promise.withResolvers<never>()
  const storage = async () => { storageEntered.resolve(); return acknowledgement.promise }
  const runtime = { run: vi.fn() }
  const service = createAiService({ storage, diagnostics, runtime, secrets: { encrypt: value => value, decrypt: value => value } })
  const request = action === 'send'
    ? service.sendTurn({ threadId: '1', requestId: 'same', prompt: '示例问题', referenceIds: [], modelId: 'm' })
    : service.confirmAnalysis({ token: 'token', requestId: 'same' })
  await storageEntered.promise
  const startedBeforeFailure = diagnostics.begin.mock.calls.length
  acknowledgement.reject(new Error('private storage failure'))
  await expect(request).rejects.toThrow('private storage failure')
  expect(startedBeforeFailure).toBe(1)
  expect(diagnostics.end).toHaveBeenCalledWith(diagnostics.begin.mock.results[0].value,
    'failed', { phase: 'prepare', code: 'OPERATION_FAILED' })
  expect(runtime.run).not.toHaveBeenCalled()
})
test('a dialogue logs the first response once, the provider counts and the committed result, without message content', async ({ onTestFinished }) => {
  const state = turnStorage()
  const diagnostics = captureDiagnostics()
  let clock = 1_000
  const timer = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  onTestFinished(() => timer.mockRestore())
  const service = createAiService({ storage: state.storage, diagnostics,
    runtime: { run: async (_input, options) => {
      options.onText('')
      clock += 12_000
      options.onText('私密')
      clock += 28_000
      options.onText('私密回答')
      return { text: '私密回答', usage: { inputTokens: 12, outputTokens: 4 }, checkpoint: '私密断点' }
    } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '私密提问', referenceIds: [], modelId: 'm' })
  await service.idle()
  const stages = diagnostics.event.mock.calls.map(call => call[1])
  expect(stages).toEqual(['queued', 'request', 'firstResponse', 'returned', 'saving', 'saved'])
  expect(diagnostics.event.mock.calls.find(call => call[1] === 'firstResponse')?.[2]).toMatchObject({ firstTokenMs: 12_000 })
  expect(diagnostics.event.mock.calls.find(call => call[1] === 'returned')?.[2]).toMatchObject({ attempt: 1, inputTokens: 12, outputTokens: 4, durationMs: 40_000 })
  expect(diagnostics.end.mock.calls[0][1]).toBe('success')
  expect(JSON.stringify(diagnostics.event.mock.calls)).not.toMatch(/私密|127\.0\.0|示例/)
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '私密提问', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(diagnostics.discardUnstarted).toHaveBeenCalledWith(diagnostics.begin.mock.results[1].value)
  expect(diagnostics.end).toHaveBeenCalledTimes(1)
})
test('stopping and retrying before the old response settles still schedules the new attempt', async () => {
  const state = turnStorage()
  const diagnostics = captureDiagnostics()
  let release: (value: any) => void = () => {}, runs = 0
  const service = createAiService({ storage: state.storage, diagnostics, runtime: { run: async () => { runs++; if (runs === 1) return new Promise(resolve => { release = resolve }); return { text: '新回答', usage: {}, checkpoint: 'new' } } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await new Promise(resolve => setTimeout(resolve, 5))
  await service.stopTurn('1')
  await service.retryTurn('1')
  release({ text: '旧回答', usage: {}, checkpoint: 'old' })
  await service.idle()
  expect(runs).toBe(2)
  expect(state.turn.text).toBe('新回答')
  expect(state.turn.state).toBe('completed')
  const [stopped, retried] = diagnostics.begin.mock.results.map(result => result.value)
  expect(stopped).not.toBe(retried)
  expect(diagnostics.event.mock.calls.filter(call => call[0] === stopped).map(call => call[1])).toContain('requestUnknown')
  expect(diagnostics.end.mock.calls.map(([id, outcome]) => [id, outcome])).toEqual(expect.arrayContaining([[stopped, 'cancelled'], [retried, 'success']]))
})
test('a queued question rechecks identity before sending its authorized context to the model', async () => {
  const state = turnStorage()
  let release: (value: any) => void = () => {}, runs = 0
  const service = createAiService({ storage: state.storage, runtime: { run: async () => { runs++; if (runs === 1) return new Promise(resolve => { release = resolve }); return { text: '不得发送的旧资料', usage: {}, checkpoint: 'cp' } } }, secrets: { encrypt: value => value, decrypt: value => value } })
  const connection = service.testModel('m')
  await new Promise(resolve => setTimeout(resolve, 5))
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await new Promise(resolve => setTimeout(resolve, 5))
  state.changeIdentity()
  release({ text: 'OK', usage: {}, checkpoint: 'test' })
  await connection
  await service.idle()
  expect(runs).toBe(1)
  expect(state.turn.state).toBe('failed')
})

test('a long thread keeps its recent complete turns and rebuilds Pi context instead of becoming permanently oversized', async () => {
  const state = turnStorage()
  const original = state.storage
  let sent: any
  const service = createAiService({ storage: async (method, args) => {
    const value = await original(method, args)
    if (method !== 'turnContext') return value
    return { ...value, checkpoint: 'oversized-native-context', history: [{ role: 'user', text: '旧'.repeat(6000) }, { role: 'assistant', text: '旧答复' }, { role: 'user', text: '最近的问题' }, { role: 'assistant', text: '最近的回答' }] }
  }, runtime: { run: async input => { sent = input; return { text: '继续回答', usage: {}, checkpoint: 'bounded' } } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(sent.history).toEqual([{ role: 'user', text: '最近的问题' }, { role: 'assistant', text: '最近的回答' }])
  expect(sent.checkpoint).toBeNull()
  expect(state.turn.state).toBe('completed')
})

test.each([
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', true],
  ['https://proxy.example/v1', false],
] as const)('模型目录决定普通对话能保留的历史，服务地址 %s', async (baseUrl, keepsHistory) => {
  const state = turnStorage({ id: 'm', label: '示例', model: 'qwen3.7-plus', baseUrl, protocol: 'openai-completions',
    contextWindow: null, maxTokens: null, version: 1, enabled: true, hasCredential: false })
  const history = [{ role: 'user' as const, text: '请保留以下材料' }, { role: 'assistant' as const, text: 'a'.repeat(300_000) }]
  const run = vi.fn<RuntimeRunner['run']>(async () => ({ text: '收到', usage: {}, checkpoint: '' }))
  const service = createAiService({ storage: async (method, args) => {
    const result = await state.storage(method, args)
    return method === 'turnContext' ? { ...result, history } : result
  }, runtime: { run }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(state.turn.state).toBe('completed')
  expect(run.mock.calls[0][0].history).toEqual(keepsHistory ? history : [])
})

test('普通模型首次发送长问题时把余下的输出额度交给运行器', async () => {
  const state = turnStorage({ id: 'm', label: '示例', model: 'local', baseUrl: 'https://proxy.example/v1',
    contextWindow: null, maxTokens: null, version: 1, enabled: true, hasCredential: false })
  state.turn.prompt = '文'.repeat(47_000)
  const run = vi.fn<RuntimeRunner['run']>(async () => ({ text: '收到', usage: {}, checkpoint: '' }))
  const service = createAiService({ storage: state.storage, runtime: { run }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: state.turn.prompt, referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(state.turn.state).toBe('completed')
  const { outputTokenLimit } = run.mock.calls[0][0]
  expect(outputTokenLimit).toBeGreaterThan(112_000)
  expect(outputTokenLimit).toBeLessThanOrEqual(115_000)
})

test('processing protects questions, references, profile and old history and discards an incompatible checkpoint', async () => {
  const state = turnStorage()
  state.turn.prompt = '示例甲的邮箱是 example@example.com'
  const original = state.storage
  const raw = { id: '7', memberId: '2', senderName: '示例甲', text: '联系 13800138000', kind: 'text', isSelf: true, sentAtMs: 0 }
  let sent: any
  const service = createAiService({
    processing: async () => ({ settings: defaultProcessing, members: [{ id: '2', displayName: '示例甲' }] }),
    storage: async (method, args) => {
      const value = await original(method, args)
      if (method !== 'turnContext') return value
      return { ...value, references: [raw], profile: { format: 'conversation-insights-v1', aboutYou: [{ content: [{ text: '示例甲 example@example.com' }] }], relationship: [], citations: [], limitations: [] }, history: [{ role: 'user', text: JSON.stringify({ id: 'example@example.com', sourceIds: ['13800138000'] }), references: [raw] }, { role: 'assistant', text: '示例甲 13800138000' }], checkpoint: JSON.stringify({ processing: 'old-rules', checkpoint: 'unprocessed-native-history' }) }
    },
    runtime: { run: async input => { sent = input; return { text: '合成回答', usage: {}, checkpoint: 'fresh-native-history' } } },
    secrets: { encrypt: value => value, decrypt: value => value },
  })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: state.turn.prompt, referenceIds: ['7'], modelId: 'm' })
  await service.idle()
  expect(state.turn.state).toBe('completed')
  expect(JSON.stringify(sent)).not.toMatch(/example@example\.com|13800138000|unprocessed-native-history/)
  expect(sent.systemPrompt).toContain('示例甲 [邮箱]')
  expect(sent.history.at(-1).text).toBe('示例甲 [手机号]')
  expect(sent.checkpoint).toBeNull()
  expect(JSON.parse(sent.prompt).references[0]).toMatchObject({ id: '7', sourceIds: ['7'], senderName: 'U2' })
  expect(raw.text).toBe('联系 13800138000')
  expect(state.turn.prompt).toContain('example@example.com')
})

test('connection tests register model work and stopping cancels active and queued requests', async () => {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  let runs = 0
  const service = createAiService({ storage: async method => { if (method === 'modelSecret') return { model, encryptedKey: null }; throw new Error(method) },
    runtime: { run: async (_input, { signal }) => { runs++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })) } }, secrets: { encrypt: value => value, decrypt: value => value } })
  const first = service.testModel('m'), second = service.testModel('m')
  const settled = Promise.allSettled([first, second])
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(service.hasModelWork(['m'])).toBe(true)
  await service.stopModelTasks(['m'])
  expect((await settled).every(result => result.status === 'rejected')).toBe(true)
  expect(runs).toBe(1)
  expect(service.hasModelWork(['m'])).toBe(false)
})

test('an explicit output limit above the unknown-context runtime fallback fails instead of being silently truncated', () => {
  const model = { contextWindow: null, maxTokens: 400000, maxInputTokens: null }
  expect(() => resolveModelLimits(model)).toThrow('请填写更大的上下文长度或减少最大输出长度。')
  expect(model).toEqual({ contextWindow: null, maxTokens: 400000, maxInputTokens: null })
})

test('a one-token context cannot produce a zero-token runtime output limit', () => {
  expect(() => resolveModelLimits({ contextWindow: 1, maxTokens: null, maxInputTokens: null })).toThrow('请增加上下文长度或减少最大输出长度。')
})

test('short requests keep the available output even when the independent input limit approaches the window', () => {
  expect(resolveModelLimits({ contextWindow: 128000, maxTokens: null, maxInputTokens: 127999 }).maxTokens).toBe(64000)
  expect(resolveModelLimits({ contextWindow: 1000000, maxTokens: null, maxInputTokens: null }).maxInputTokens).toBe(144000)
  expect(resolveModelLimits({ contextWindow: null, maxTokens: null }, { contextWindow: 40960, maxTokens: 32768 }).maxTokens).toBe(32768)
})

test('independent input and output ceilings share the context budget without rewriting either ceiling', () => {
  const model = { contextWindow: 128000, maxTokens: 16000, maxInputTokens: 128000 }
  expect(resolveModelLimits(model)).toEqual({ contextWindow: 128000, maxTokens: 16000, maxInputTokens: 128000 })
  expect(model.maxInputTokens).toBe(128000)
})

test('connection testing rejects an input limit too small for its test prompt before sending', async () => {
  const model: AiModel = { id: 'tiny', label: '示例', model: 'tiny', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, maxInputTokens: 1, version: 1, enabled: true, hasCredential: false }
  let requests = 0
  const service = createAiService({ storage: async () => ({ model, encryptedKey: null }), runtime: { run: async () => { requests++; return { text: 'OK', usage: {}, checkpoint: 'cp' } } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await expect(service.testModel(model.id)).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE', action: expect.stringContaining('最大输入长度') })
  expect(requests).toBe(0)
})

test('Responses 对话在最大输出小于协议下限时本地失败', async () => {
  const state = turnStorage({ id: 'm', label: '测试', model: 'local', baseUrl: 'http://localhost/v1',
    protocol: 'openai-responses', contextWindow: 32_000, maxTokens: 8, version: 1, enabled: true, hasCredential: false })
  const run = vi.fn<RuntimeRunner['run']>(async () => ({ text: 'OK', usage: {}, checkpoint: '' }))
  const service = createAiService({ storage: state.storage, runtime: { run }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(state.turn).toMatchObject({ state: 'failed', error: expect.stringContaining('16') })
  expect(run).not.toHaveBeenCalled()
})

test.each([
  ['openai-responses', 15], ['openai-responses', 16], ['openai-completions', 8],
] as const)('%s 检测连接在仅剩 %i 个输出词元时按协议限制发送', async (protocol, remaining) => {
  const promptSize = 1000 + Buffer.byteLength('Reply OK.' + 'OK' + '[]')
  const contextWindow = promptSize + remaining
  const model: AiModel = { id: 'm', label: '测试', model: 'local', baseUrl: 'http://localhost/v1',
    protocol, contextWindow, maxInputTokens: contextWindow, maxTokens: 256, version: 1, enabled: true, hasCredential: false }
  const run = vi.fn<RuntimeRunner['run']>(async () => ({ text: 'OK', usage: {}, checkpoint: '' }))
  const service = createAiService({ storage: async () => ({ model, encryptedKey: null }), runtime: { run }, secrets: { encrypt: value => value, decrypt: value => value } })
  if (protocol === 'openai-responses' && remaining < 16) {
    await expect(service.testModel(model.id)).rejects.toMatchObject({ action: expect.stringContaining('16') })
    expect(run).not.toHaveBeenCalled()
  } else {
    await service.testModel(model.id)
    expect(run.mock.calls[0][0].outputTokenLimit).toBe(remaining)
  }
})


test.each(['半句', ''])('length-limited dialogue remains failed and retryable without committing a checkpoint: %s', async text => {
  const state = turnStorage()
  const service = createAiService({ storage: state.storage, runtime: { run: async (_input, options) => {
    options.onText(text)
    return { text, stopReason: 'length', usage: { outputTokens: 1000 }, checkpoint: 'must-not-commit' }
  } }, secrets: { encrypt: String, decrypt: String } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await service.idle()
  expect(state.turn).toMatchObject({ state: 'failed', text })
  expect(state.turn).not.toHaveProperty('checkpoint', 'must-not-commit')
})
