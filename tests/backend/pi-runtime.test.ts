import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import type { AiModel } from '../../src/shared/ai-contract'
import { generateInsight } from '../../electron/main/insight-generation'
import { generatePiInsight, type PiInsightCheckpoint } from '../../electron/main/pi-insight-generation'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'
import { defaultInsightRunLimits } from '../../electron/main/insight-policy'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { defaultProcessing } from '../../src/shared/settings-contract'
import type { InsightRuntimeEvent } from '../../electron/agent/protocol'

describe('Pi runtime over a controlled OpenAI compatible service', () => {
  beforeAll(async () => { await import('@earendil-works/pi-coding-agent') }, 30000)
  let directory: string
  let server: ReturnType<typeof createServer>
  let model: AiModel
  let requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[]
  let answer: (response: ServerResponse) => void
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'whomi-pi-'))
    requests = []
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { role: 'assistant', content: '已' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '收到' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => { requests.push(JSON.parse(body)); answer(response) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    model = { id: 'example-service', label: '测试模型', model: 'example-model', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  const options = () => ({ signal: new AbortController().signal, onText: () => {} })
  const input = (model: AiModel, prompt = '示例提问') => ({ key: 'example-thread', model, systemPrompt: '仅依据本轮许可材料回答。', prompt })

  function overloadFixture() {
    const states: PiInsightCheckpoint[] = []
    const events: InsightRuntimeEvent[] = []
    const runtime = new PiRuntime(directory)
    const controller = new AbortController()
    const operation = aiOperation(undefined, 'insight', 'generate')
    const source = { id: '1', revision: 'a'.repeat(64), senderName: '本人', isSelf: true, text: '周三散步。', replyToMessageId: null, sentAtMs: 0 }
    const read = vi.fn(async () => [source])
    const run = (checkpoint: PiInsightCheckpoint | null = null) => generatePiInsight({
      snapshot: { taskId: '7', scope: { kind: 'all' }, timezone: 'UTC', createdAtMs: 0, sourceStartTimeMs: 0, sourceEndTimeMs: 0,
        sources: [{ messageId: source.id, revision: source.revision }] },
      conversationId: '1', model: { ...model, protocol: 'openai-responses' }, thinkingLevel: undefined,
      prompts: defaultInsightPrompts, processing: defaultProcessing, checkpoint, signal: controller.signal, operation, read,
      save: async state => { states.push(structuredClone(state)) },
      run: (request, io) => runtime.run(request, { signal: controller.signal, onText: () => {}, insight: {
        read: io.read, record: async event => { events.push(event); return io.record(event) } } }),
    })
    return { run, events, states, operation, controller, read }
  }
  function frames(response: ServerResponse, ...events: unknown[]) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
  }
  const busy = { type: 'response.failed', response: { status: 'failed', error: {
    code: 'server_error', message: 'The server is overloaded. Please try again later.' } } }
  function jsonError(response: ServerResponse, status: number, code: string, message: string) {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code, message } }))
  }

  it('resumes the native tool result after two explicit overloads, keeps receipts and never resends the saved report', async () => {
    const fixture = overloadFixture()
    const received: number[] = []
    const sections = [{ content: [{ text: '周三散步', citationId: 'c1' }] }]
    const report = { aboutYou: sections, relationship: sections, citations: [{ id: 'c1', fragments: [{ messageIds: ['1'] }] }], limitations: [] }
    answer = response => {
      received.push(Date.now())
      if (requests.length === 2) return frames(response, busy)
      if (requests.length === 3) return jsonError(response, 503, 'service_unavailable', 'The service is temporarily unavailable.')
      const item = requests.length === 1 ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_messages', arguments: '{}' }
        : { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(report) }] }
      frames(response, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 15, output_tokens: 5 } } })
    }
    const saved = await fixture.run()
    expect(requests).toHaveLength(4)
    expect(received[2] - received[1]).toBeGreaterThanOrEqual(1950)
    expect(received[3] - received[2]).toBeGreaterThanOrEqual(7950)
    for (const request of requests.slice(1)) expect(request).toMatchObject({ input: expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: expect.stringContaining('周三散步。') }),
    ]) })
    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(fixture.events.filter(event => event.type === 'request').map(event => [event.success, event.spans.length]))
      .toEqual([[true, 0], [false, 0], [false, 0], [true, 1]])
    const checkpoints = fixture.states.flatMap(state => state.checkpoint ? [JSON.parse(state.checkpoint).sessionFile] : [])
    expect(new Set(checkpoints).size).toBe(1)
    expect(fixture.states.at(-1)).toMatchObject({ requests: 4, taskId: '7', input: 30, output: 10, coverage: { coveredMessageIds: ['1'] }, report: saved })
    expect(await fixture.run(fixture.states.at(-1))).toEqual(saved)
    expect(requests).toHaveLength(4)
  }, 30000)

  it.each(['invalid', 'unavailable-model', 'quota', 'partial', 'interrupted', 'exhausted', 'paused'] as const)(
    'handles %s without uncontrolled resubmission', async mode => {
      const fixture = overloadFixture()
      answer = response => {
        if (mode === 'invalid') return jsonError(response, 400, 'invalid_request_error', 'Unsupported tool parameter: server_overloaded')
        if (mode === 'unavailable-model') return jsonError(response, 400, 'model_not_found', 'The model is unavailable for this account.')
        if (mode === 'quota') return jsonError(response, 429, 'insufficient_quota', 'The server is overloaded.')
        if (mode === 'partial') return frames(response,
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
          { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
          { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '已开始撰写。' }, busy)
        if (mode === 'interrupted') return frames(response, { type: 'response.created', response: { id: 'resp_incomplete', status: 'in_progress' } })
        frames(response, busy)
      }
      const retry = vi.spyOn(fixture.operation, 'event')
      if (mode === 'paused') retry.mockImplementation(stage => {
        if (stage === 'retry') setTimeout(() => fixture.controller.abort(), 10)
      })
      await expect(fixture.run()).rejects.toMatchObject(mode === 'paused' ? { name: 'AbortError' }
        : { code: mode === 'exhausted' ? 'MODEL_UNAVAILABLE' : 'MODEL_REQUEST_FAILED' })
      expect(requests).toHaveLength(mode === 'exhausted' ? 3 : 1)
      expect(retry.mock.calls.filter(([stage]) => stage === 'retry')).toHaveLength(mode === 'exhausted' ? 2 : mode === 'paused' ? 1 : 0)
      expect(fixture.states.at(-1)).toMatchObject({ requests: requests.length, checkpoint: expect.any(String), coverage: { coveredMessageIds: [] } })
    }, 30000)

  it.each(['openai-completions', 'openai-responses'] as const)('runs the official insight from %s on Responses and replays the tool output with its source', async protocol => {
    const localFetch = globalThis.fetch
    const routes: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      routes.push(String(url))
      return localFetch(model.baseUrl + '/local-fixture', init)
    })
    const selected = { ...model, model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1', protocol }
    const section = [{ content: [{ text: '一起散步', citationId: 'c1' }] }]
    const report = { aboutYou: section, relationship: section, citations: [{ id: 'c1', fragments: [{ messageIds: ['1'] }] }], limitations: [] }
    const normalAnswer = answer
    answer = response => {
      if (!routes.at(-1)?.endsWith('/responses')) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Use /responses for function tools with this model.' } }))
        return
      }
      const first = requests.length === 1
      const item = first ? { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_messages', arguments: '{}' }
        : { type: 'message', id: 'msg_report', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(report) }] }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frames = [{ type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: first ? 'resp_read' : 'resp_report', status: 'completed', output: [item],
          usage: { input_tokens: 15, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } }]
      response.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
    }
    const runtime = new PiRuntime(directory)
    const settled: InsightRuntimeEvent[] = []
    const source = { id: '1', revision: 'a'.repeat(64), senderName: '本人', isSelf: true, text: '周末一起散步', replyToMessageId: null, sentAtMs: 0 }
    const saved = await generatePiInsight({
      snapshot: { taskId: '1', scope: { kind: 'all' }, timezone: 'UTC', createdAtMs: 0, sourceStartTimeMs: 0, sourceEndTimeMs: 0,
        sources: [{ messageId: source.id, revision: source.revision }] },
      conversationId: '1', model: selected, thinkingLevel: undefined, prompts: defaultInsightPrompts, processing: defaultProcessing,
      checkpoint: null, signal: AbortSignal.timeout(10000), operation: aiOperation(undefined, 'insight', 'generate'), save: async () => {},
      read: async () => [source], run: (request, io) => runtime.run(request, { ...options(), insight: { read: io.read,
        record: async event => { settled.push(event); await io.record(event) } } }),
    })
    expect(saved.citations[0].fragments[0].sources).toEqual([{ messageId: '1', revision: source.revision }])
    expect(routes).toEqual(Array(2).fill('https://api.openai.com/v1/responses'))
    expect(selected.protocol).toBe(protocol)
    for (const req of requests) {
      expect(req).toMatchObject({ model: 'gpt-6.1-sol', store: false, tools: [expect.objectContaining({ type: 'function', name: 'read_messages', strict: false })],
        include: expect.arrayContaining(['reasoning.encrypted_content']) })
      expect(req).not.toHaveProperty('reasoning')
      expect(req).not.toHaveProperty('previous_response_id')
    }
    expect(requests[1]).toMatchObject({ input: expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call_read', id: 'fc_read' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_read', output: expect.stringContaining(source.text) }),
    ]) })
    const expectedUsage = { inputTokens: 11, totalInputTokens: 15, cacheReadTokens: 4, outputTokens: 5 }
    expect(settled.filter(event => event.type === 'request')).toMatchObject([
      { success: true, spans: [], usage: expectedUsage }, { success: true, spans: [{ messageId: '1' }], usage: expectedUsage },
    ])
    const checkpoint = settled.find(event => event.type === 'checkpoint')!.checkpoint
    const protocols = fs.readFileSync(JSON.parse(checkpoint).sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).message)
      .filter(message => message?.role === 'assistant').map(message => message.api)
    expect(protocols).toEqual(['openai-responses', 'openai-responses'])
    await runtime.run({ ...input(selected), key: 'explicit-thinking', thinkingLevel: 'high', insightSession: { processing: defaultProcessing } },
      { ...options(), insight: { read: vi.fn(), record: async () => {} } })
    expect(requests.at(-1)).toMatchObject({ reasoning: { effort: 'high' } })
    answer = normalAnswer
    await runtime.run(input({ ...selected, protocol: 'openai-completions' }), options())
    await runtime.run({ ...input({ ...selected, protocol: 'openai-completions', baseUrl: model.baseUrl }), insightSession: { processing: defaultProcessing } },
      { ...options(), insight: { read: vi.fn(), record: async () => {} } })
    expect(routes.slice(3)).toEqual(['https://api.openai.com/v1/chat/completions', model.baseUrl + '/chat/completions'])
  }, 20000)

  it('opens the first user-message checkpoint in a new runtime when the first model request gets no answer', async () => {
    const runInput = { ...input(model), purpose: 'insight' as const, insightSession: { processing: defaultProcessing } }
    const events: InsightRuntimeEvent[] = []
    const callbacks = { read: vi.fn(), record: async (event: InsightRuntimeEvent) => { events.push(event) } }
    const success = answer
    answer = response => { response.writeHead(503); response.end() }
    await expect(new PiRuntime(directory).run(runInput, { ...options(), insight: callbacks })).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
    const checkpoint = events.find(e => e.type === 'checkpoint')?.checkpoint
    expect(checkpoint).toBeTruthy()
    expect(existsSync(JSON.parse(checkpoint!).sessionFile)).toBe(true)
    expect(events.filter(e => e.type === 'request')).toMatchObject([{ success: false, spans: [], usage: { incomplete: true } }])
    answer = success
    const resumed = await new PiRuntime(directory).run({ ...runInput, checkpoint, prompt: '继续同一项洞察。' }, { ...options(), insight: callbacks })
    expect(JSON.parse(resumed.checkpoint).sessionFile).toBe(JSON.parse(checkpoint!).sessionFile)
    expect(requests[1].messages.filter(message => message.role === 'user')).toMatchObject([
      { content: [{ text: '示例提问' }] }, { content: [{ text: '继续同一项洞察。' }] },
    ])
    expect(callbacks.read).not.toHaveBeenCalled()
  }, 20000)

  it('resumes the same Pi tool result after pausing before inference and confirms it only after a successful request', async () => {
    const events: InsightRuntimeEvent[] = []
    const span = { messageId: 'm3', start: 0, end: 3, length: 3 }
    const controller = new AbortController()
    const runInput = { ...input(model), purpose: 'insight' as const, insightSession: { processing: defaultProcessing } }
    const read = vi.fn(async () => ({ page: { status: 'ok' as const, nextCursor: null, messages: [{ id: 'm3', text: '周五见', sentAtMs: 0, senderName: '本人', isSelf: true, replyToMessageId: null }] }, spans: [span] }))
    const normalAnswer = answer
    answer = response => {
      if (requests.length === 1) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = { role: 'assistant', content: '回查邮箱 pi-note@example.org', tool_calls: [
          { index: 0, id: 'call1', type: 'function', function: { name: 'read_messages', arguments: '{}' } },
        ] }
        response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n')
      } else if (requests.length === 2) controller.abort()
      else normalAnswer(response)
    }
    const callbacks = { read, record: async (event: InsightRuntimeEvent) => { events.push(event) } }
    const runtime = new PiRuntime(directory)
    await expect(runtime.run(runInput, { ...options(), signal: controller.signal, insight: callbacks })).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.filter(e => e.type === 'request' && e.success).flatMap(e => e.type === 'request' ? e.spans : [])).toEqual([])
    const checkpoint = events.filter(e => e.type === 'checkpoint').at(-1)?.checkpoint
    expect(checkpoint).toBeTruthy()
    const result = await runtime.run({ ...runInput, checkpoint }, { ...options(), insight: callbacks })
    expect(result.text).toBe('已收到')
    expect(read).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(3)
    expect(requests[0].tools).toMatchObject([{ function: { name: 'read_messages' } }])
    for (const req of requests.slice(1)) {
      expect(JSON.stringify(req)).toContain('周五见')
      expect(JSON.stringify(req)).toContain('[邮箱]')
      expect(JSON.stringify(req)).not.toContain('pi-note@example.org')
    }
    expect(events.filter(e => e.type === 'request')).toMatchObject([
      { success: true, spans: [], usage: { inputTokens: 11, outputTokens: 4 } },
      { success: false, spans: [], usage: { incomplete: true } },
      { success: true, spans: [span], usage: { inputTokens: 12, outputTokens: 3 } },
    ])
    expect(JSON.parse(result.checkpoint).sessionFile).toBe(JSON.parse(checkpoint!).sessionFile)
  }, 30000)

  it('recognizes an upstream gateway timeout for insights while keeping normal dialogue errors unchanged', async () => {
    answer = response => {
      response.writeHead(504, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'private gateway detail', code: 'gateway_timeout' } }))
    }
    for (const purpose of ['insight', undefined] as const) {
      const result = new PiRuntime(directory).run({ ...input(model), purpose }, options())
      await expect(result).rejects.toMatchObject({ code: purpose ? 'MODEL_TIMEOUT' : 'MODEL_REQUEST_FAILED' })
    }
  }, 20000)

  it('counts native compaction requests and protects the model-written summary before continuing with the read result', async () => {
    const events: InsightRuntimeEvent[] = []
    const longMessage = '约在周五。'.repeat(1800)
    const span = { messageId: 'm1', start: 0, end: longMessage.length, length: longMessage.length }
    let ordinaryRequests = 0
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const compacting = JSON.stringify(requests.at(-1)?.messages[0]).includes('context summarization assistant')
      if (!compacting) ordinaryRequests++
      const tool = !compacting && ordinaryRequests === 1
      const delta = tool ? { role: 'assistant', content: '先查看发言。', tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read_messages', arguments: '{}' } }] }
        : { role: 'assistant', content: compacting ? '压缩笔记：示例联系值 summary@example.org。' : '首次报告' }
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: tool ? 5800 : 20, completion_tokens: 12 } }) + '\n\ndata: [DONE]\n\n')
    }
    const privateFolder = 'synthetic-personal-insight-folder'
    const result = await new PiRuntime(join(directory, privateFolder)).run({ ...input({ ...model, contextWindow: 8000 }), insightSession: { processing: defaultProcessing } }, {
      ...options(), insight: {
        read: async () => ({ page: { status: 'ok', messages: [{ id: 'm1', isSelf: true, senderName: '本人', text: longMessage, replyToMessageId: null, sentAtMs: 0 }], nextCursor: null }, spans: [span] }),
        record: async event => { events.push(event) },
      },
    })
    expect(result.text).toBe('首次报告')
    const receipts = events.filter(e => e.type === 'request')
    expect(receipts.filter(e => e.kind === 'compaction').length).toBeGreaterThan(0)
    expect(receipts.length).toBe(requests.length)
    expect(receipts.every(e => e.success && e.usage.outputTokens === 12)).toBe(true)
    for (const request of requests) {
      expect(JSON.stringify(request.messages[0])).toContain('仅依据本轮许可材料回答')
      expect(JSON.stringify(request)).not.toContain(privateFolder)
      expect(JSON.stringify(request)).not.toContain('<cwd>')
    }
    expect(receipts.at(-1)?.spans).toEqual([span])
    expect(JSON.stringify(requests.at(-1))).toContain('压缩笔记')
    expect(JSON.stringify(requests.at(-1))).toContain('仅依据本轮许可材料回答')
    expect(JSON.stringify(requests.at(-1))).not.toContain('summary@example.org')
  }, 30000)

  it('keeps an ordinary Google validation error out of the timeout retry', async () => {
    answer = response => {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'private gateway detail' } }))
    }
    const result = new PiRuntime(directory).run({ ...input({ ...model, protocol: 'google-generative-ai' }), purpose: 'insight' }, options())
    await expect(result).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
    expect(requests).toHaveLength(1)
  }, 20000)

  it('retries the same Google reading request once after HTTP 504 and finishes the report', async () => {
    answer = response => {
      if (requests.length === 1) {
        response.writeHead(504, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'private gateway detail' } }))
        return
      }
      const reply = requests.length === 2 ? { observations: [], openThreads: [], candidates: [] }
        : { aboutYou: [], relationship: [], citations: [], judgments: [], limitations: ['材料有限。'] }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const candidate = { content: { role: 'model', parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }
      response.end('data: ' + JSON.stringify({ candidates: [candidate] }) + '\n\n')
    }
    const runtime = new PiRuntime(directory)
    const message = { id: '1', revision: 'r1', senderName: '本人', isSelf: true, text: '周五见。', sentAtMs: 1000, replyToMessageId: null }
    const report = await generateInsight({
      snapshot: { taskId: '1', scope: { kind: 'all' }, timezone: 'UTC', createdAtMs: 1000, sourceStartTimeMs: 1000, sourceEndTimeMs: 1000,
        sources: [{ messageId: message.id, revision: message.revision }] },
      conversationId: '1', model: { ...model, protocol: 'google-generative-ai' }, prompts: defaultInsightPrompts, limits: defaultInsightRunLimits, checkpoint: null,
    }, { ...options(), read: async () => [message], saveCheckpoint: async () => {}, run: (request, context) => runtime.run(request, context) })
    expect(requests).toHaveLength(3)
    expect(requests[1]).toEqual(requests[0])
    expect(report.limitations).toEqual(['材料有限。'])
  }, 20000)

  it('uses the upstream request fallback without saving invented model capacities', async () => {
    const unknown = { ...model, contextWindow: null, maxTokens: null }
    const result = await new PiRuntime(directory).run(input(unknown as unknown as AiModel), options())
    expect(result.text).toBe('已收到')
    const request = requests[0] as Record<string, unknown>
    expect(request.max_tokens ?? request.max_completion_tokens).toBe(8192)
    expect(unknown.contextWindow).toBeNull()
    expect(unknown.maxTokens).toBeNull()
  }, 20000)

  it('streams real Pi output, records reported usage, and exposes no tools or ambient instructions', async () => {
    mkdirSync(join(directory, 'ai-runtime'), { recursive: true })
    writeFileSync(join(directory, 'ai-runtime', 'SYSTEM.md'), 'AMBIENT_SECRET')
    writeFileSync(join(directory, 'ai-runtime', 'APPEND_SYSTEM.md'), 'AMBIENT_APPEND_SECRET')
    writeFileSync(join(directory, 'ai-runtime', 'AGENTS.md'), 'AMBIENT_AGENT_SECRET')
    mkdirSync(join(directory, 'ai-runtime', 'skills', 'ambient'), { recursive: true })
    writeFileSync(join(directory, 'ai-runtime', 'skills', 'ambient', 'SKILL.md'), '---\nname: ambient\ndescription: AMBIENT_SKILL_SECRET\n---\nAMBIENT_BODY')
    mkdirSync(join(directory, 'ai-runtime', 'extensions'), { recursive: true })
    const extensionMarker = join(directory, 'extension-executed')
    writeFileSync(join(directory, 'ai-runtime', 'extensions', 'ambient.js'), `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(extensionMarker)}, 'executed')`)
    const chunks: string[] = []
    const result = await new PiRuntime(directory).run(input(model), { ...options(), onText: text => chunks.push(text) })
    expect(result.text).toBe('已收到')
    expect(chunks).toEqual(['已', '已收到'])
    expect(result.usage).toMatchObject({ inputTokens: 12, totalInputTokens: 12, outputTokens: 3, incomplete: false, startedAt: expect.any(Number), completedAt: expect.any(Number) })
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_SECRET')
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_APPEND_SECRET')
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_AGENT_SECRET')
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_SKILL_SECRET')
    expect(existsSync(extensionMarker)).toBe(false)
    expect(requests[0].tools ?? []).toEqual([])
    expect(JSON.parse(result.checkpoint)).toMatchObject({ leafId: expect.any(String), sessionFile: expect.any(String) })
  }, 20000)

  it('restores only the committed checkpoint after a later uncommitted attempt', async () => {
    const first = await new PiRuntime(directory).run(input(model, '已提交提问'), options())
    await new PiRuntime(directory).run({ ...input(model, '未提交提问'), checkpoint: first.checkpoint }, options())
    await new PiRuntime(directory).run({ ...input(model, '重启后提问'), checkpoint: first.checkpoint }, options())
    expect(JSON.stringify(requests[2].messages)).toContain('已提交提问')
    expect(JSON.stringify(requests[2].messages)).not.toContain('未提交提问')
  }, 20000)

  it('honors an explicitly empty history instead of restoring checkpoint messages', async () => {
    const first = await new PiRuntime(directory).run(input(model, '不应恢复的旧提问'), options())
    await new PiRuntime(directory).run({ ...input(model, '当前提问'), history: [], checkpoint: first.checkpoint }, options())
    expect(requests[1].messages.filter(message => message.role !== 'system')).toEqual([
      { role: 'user', content: [{ type: 'text', text: '当前提问' }] },
    ])
  }, 20000)

  it('never scans the host skill directory even when it exists', async () => {
    const hostSkills = resolve(process.env.HOME || homedir(), '.agents', 'skills')
    const scans: string[] = []
    const originalExists = fs.existsSync
    const originalReadDirectory = fs.readdirSync
    vi.spyOn(fs, 'existsSync').mockImplementation(path => {
      const target = resolve(String(path))
      if (target === hostSkills) return true
      if (target.startsWith(hostSkills + sep)) return false
      return originalExists(path)
    })
    vi.spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (resolve(String(path)) === hostSkills) { scans.push(String(path)); return [] }
      return Reflect.apply(originalReadDirectory, fs, [path, ...args])
    }) as typeof fs.readdirSync)
    syncBuiltinESMExports()
    await new PiRuntime(directory).run(input(model), options())
    expect(scans).toEqual([])
  }, 20000)

  it('rejects checkpoint files outside the task session directory without a model request', async () => {
    await expect(new PiRuntime(directory).run({ ...input(model), checkpoint: JSON.stringify({ sessionFile: join(directory, 'other.jsonl'), leafId: 'bad' }) }, options())).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' })
    expect(requests).toHaveLength(0)
  })

  it('rejects another thread checkpoint before sending any of its history', async () => {
    const first = await new PiRuntime(directory).run(input(model, '其他线程保密提问'), options())
    await expect(new PiRuntime(directory).run({ ...input(model), key: 'different-thread', checkpoint: first.checkpoint }, options())).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' })
    expect(requests).toHaveLength(1)
  }, 20000)

  it('keeps absent provider token counts unknown', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '未报告用量' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    }
    const result = await new PiRuntime(directory).run(input(model), options())
    expect(result.usage.inputTokens).toBeUndefined()
    expect(result.usage.outputTokens).toBeUndefined()
    expect(result.usage.incomplete).toBe(true)
  }, 20000)

  it.each([
    { raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800 }, expected: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 800, incomplete: false } },
    { raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 } }, expected: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 200, incomplete: false } },
    { raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, expected: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, incomplete: false } },
  ])('preserves reported cache usage alongside uncached input: $raw', async ({ raw, expected }) => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '带缓存用量' }, finish_reason: 'stop' }], usage: raw })}\n\ndata: [DONE]\n\n`)
    }
    const result = await new PiRuntime(directory).run(input(model), options())
    expect(result.usage).toMatchObject({ ...expected, totalInputTokens: 1000 })
    if (!('cacheWriteTokens' in expected)) expect(result.usage.cacheWriteTokens).toBeUndefined()
  }, 20000)

  it('aborts an in-flight Pi request and never returns a committed checkpoint', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '部分' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '文字' }, finish_reason: null }] })}\n\n`)
    }
    const controller = new AbortController()
    let displayed = ''
    let updates = 0
    await expect(new PiRuntime(directory).run(input(model), { signal: controller.signal, onText: text => { displayed = text; if (++updates === 2) controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(displayed).toBe('部分文字')
    expect(requests).toHaveLength(1)
  }, 20000)

  it('retains provider-reported usage on a failed stream without silently retrying', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '失败前文字' }, finish_reason: null }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`)
      setTimeout(() => response.destroy(), 40)
    }
    await expect(new PiRuntime(directory).run(input(model), options())).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED', usage: { inputTokens: 8, outputTokens: 2 } })
    expect(requests).toHaveLength(1)
  }, 20000)
  it('marks length-limited output explicitly while retaining partial text and actual usage', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '{"events":[' }, finish_reason: 'length' }], usage: { prompt_tokens: 500, completion_tokens: 1000, total_tokens: 1500 } })}\n\ndata: [DONE]\n\n`)
    }
    const result = await new PiRuntime(directory).run(input(model), options())
    expect(result).toMatchObject({ stopReason: 'length', text: '{"events":[', usage: { totalInputTokens: 500, outputTokens: 1000 } })
  }, 20000)

})
