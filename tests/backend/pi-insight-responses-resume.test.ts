import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { addInsightCoverage, createInsightReader } from '../../electron/main/insight-reader'
import { createMessageProcessor } from '../../electron/main/message-processing'
import type { InsightRuntimeEvent } from '../../electron/agent/protocol'
import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightReadPage } from '../../src/shared/insight-reader'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { assembleMethodologyPrompt, createMethodologySnapshot } from '../../electron/data/ai/methodology'
import { defaultPrompts } from '../../src/shared/system-prompts'

type InputItem = { type?: string; id?: string; call_id?: string; output?: unknown; encrypted_content?: string }
type Request = { input?: InputItem[]; store?: boolean; previous_response_id?: string; messages?: unknown[]; max_output_tokens?: number }
let server: ReturnType<typeof createServer>, directory: string, model: AiModel
let answer: (path: string, body: Request, response: ServerResponse) => void
const requests: Request[] = []
const authorizations: (string | undefined)[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'whomi-insight-response-replay-'))
  requests.length = 0
  authorizations.length = 0
  server = createServer((req, response) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      const body: Request = JSON.parse(text)
      requests.push(body)
      authorizations.push(req.headers.authorization)
      answer(req.url!, body, response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  model = { id: 'fixture', model: 'fixture', label: '本地测试', version: 1, enabled: true, hasCredential: false,
    protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1',
    contextWindow: 8000, maxTokens: 1000 }
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})

function responses(response: ServerResponse, items: object[], inputTokens: number | null = 25, outputTokens = 12, status: 'completed' | 'incomplete' = 'completed') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (event: object) => response.write('data: ' + JSON.stringify(event) + '\n\n')
  for (const [output_index, item] of items.entries()) {
    emit({ type: 'response.output_item.added', output_index, item })
    emit({ type: 'response.output_item.done', output_index, item })
  }
  emit({ type: 'response.' + status, response: { id: 'resp_local', status, output: items,
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(inputTokens !== null && { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }) } })
  response.end()
}
const textItem = (text: string) => ({ type: 'message', role: 'assistant', id: 'msg_local', content: [{ type: 'output_text', text }] })
function sample(text: string) {
  const span = { messageId: '1', start: 0, end: text.length, length: text.length }
  const events: InsightRuntimeEvent[] = []
  const read = vi.fn(async () => ({ spans: [span], page: { status: 'ok' as const, nextCursor: null,
    messages: [{ id: '1', isSelf: true, senderName: '本人', sentAtMs: null, replyToMessageId: null, text }] } }))
  return { span, events, options: { signal: AbortSignal.timeout(20000), onText() {},
    insight: { read, record: async (event: InsightRuntimeEvent) => { events.push(event) } } }, read,
    input: { key: 'insight:1', model, purpose: 'insight' as const, insightSession: { processing: defaultProcessing },
      systemPrompt: '仅依据聊天原文回答。', prompt: '开始阅读。' } }
}

it.each([3300, null])('八千共享窗口用冻结方法读取首条消息，用量回执 %s', async inputTokens => {
  const { input, options, read } = sample('示例：周末一起散步。')
  const editable = defaultPrompts.insight
  const systemPrompt = assembleMethodologyPrompt(createMethodologySnapshot('insight'), editable)
  const task = { ...input, systemPrompt, model: { ...model, contextWindow: 8192, maxInputTokens: 8192, maxTokens: 1024 },
    insightSession: { ...input.insightSession, fixedPromptLength: systemPrompt.length - editable.length } }
  let readBudget = 0
  answer = (_path, _body, response) => responses(response, requests.length === 1
    ? [{ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_messages', arguments: '{}' }]
    : [textItem('已读完')], inputTokens)
  const result = await new PiRuntime(directory).run(task, { ...options, insight: { ...options.insight,
    read: async (_request, available) => { readBudget = available; return read() } } })
  expect(result.text).toBe('已读完')
  expect(readBudget).toBeGreaterThan(256)
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    expect(request.max_output_tokens).toBeGreaterThanOrEqual(16)
    expect(request.max_output_tokens).toBeLessThanOrEqual(1024)
  }
}, 30000)

it('长洞察压缩前后完整保留一次 Personalysis 与冻结宿主指令', async () => {
  const { input, options, events } = sample('合成原文：这次提出邀请，尚未看到后续。'.repeat(1800))
  const snapshot = createMethodologySnapshot('insight')
  input.model = { ...model, contextWindow: 32000, maxTokens: 2000 }
  input.systemPrompt = assembleMethodologyPrompt(snapshot, defaultPrompts.insight)
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) responses(response, [textItem('示例摘要：保留邀请和未知回应。')])
    else if (requests.length === 1) responses(response, [{ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_messages', arguments: '{}' }], 29000)
    else responses(response, [textItem('示例成稿')])
  }
  const result = await new PiRuntime(directory).run(input, options)
  expect(result.text).toBe('示例成稿')
  expect(events.filter(event => event.type === 'request').map(event => event.kind)).toEqual(['inference', 'compaction', 'inference'])
  expect(requests).toHaveLength(3)
  expect(JSON.stringify(requests[1])).toContain('报告结构用于最终交稿，本次只生成阅读笔记')
  for (const request of requests) {
    const serialized = JSON.stringify(request)
    expect(serialized.split(JSON.stringify(snapshot.methodology.body).slice(1, -1))).toHaveLength(2)
    expect(serialized).toContain(JSON.stringify(snapshot.hostAdapter.instructions).slice(1, -1))
    expect(request.max_output_tokens).toBeGreaterThan(0)
    expect(request.max_output_tokens).toBeLessThanOrEqual(2000)
  }
}, 30000)

it('同一洞察的每次模型请求使用当轮服务地址与凭据', async () => {
  const { input, options, read } = sample('合成原文。'.repeat(1800))
  const kinds: string[] = []
  const requestIds: string[] = []
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) responses(response, [textItem('核查原话')])
    else if (requests.length === 1) responses(response, [{ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_messages', arguments: '{}' }], 5800)
    else responses(response, [textItem('已成稿')])
  }
  const result = await new PiRuntime(directory).run({ ...input, model: { ...input.model, baseUrl: 'http://127.0.0.1:1' } },
    { ...options, insight: { ...options.insight, record: async event => {
      if (event.type !== 'requestStart') return
      kinds.push(event.kind)
      requestIds.push(event.requestId)
      return { access: { token: 'sample-' + kinds.length, baseUrl: model.baseUrl } }
    } } })
  expect(result.text).toBe('已成稿')
  expect(kinds).toEqual(['inference', 'compaction', 'inference'])
  expect(read).toHaveBeenCalledWith({}, expect.any(Number), requestIds[0])
  expect(authorizations).toEqual(['Bearer sample-1', 'Bearer sample-2', 'Bearer sample-3'])
  const history = await readFile(JSON.parse(result.checkpoint).sessionFile, 'utf8')
  expect(history).not.toMatch(/sample-[123]/)
}, 30000)

it('服务只报告压缩用量时保留未知结束原因', async () => {
  const { input, options, events } = sample('周五见。'.repeat(1800))
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) {
      const item = textItem('摘要。')
      const frames = [{ type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { output: [item], usage: { input_tokens: 100, output_tokens: 1000 } } }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
    } else if (requests.length === 1) {
      responses(response, [{ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_messages', arguments: '{}' }], 5800)
    } else responses(response, [textItem('已完成')])
  }
  await new PiRuntime(directory).run(input, options)
  expect(events).toContainEqual(expect.objectContaining({ type: 'request', kind: 'compaction',
    stopReason: 'unknown', usage: expect.objectContaining({ outputTokens: 1000 }) }))
}, 30000)

it('相同原文页的顺读和首次回查分别确认，后续重复回查保持去重', async () => {
  const { input, options, events, read, span } = sample('周五见。')
  let reads = 0
  let reviewCheckpoint: string | undefined
  answer = (_path, _body, response) => {
    const turn = requests.length
    responses(response, turn > 3 ? [textItem('已完成')] : [{ type: 'function_call', id: 'fc_' + turn,
      call_id: 'call_' + turn, name: 'read_messages', arguments: turn === 1 ? '{}' : '{"messageId":"1"}' }])
  }
  const insight = { record: async (event: InsightRuntimeEvent) => {
    await options.insight.record(event)
    if (event.type === 'checkpoint' && reads === 2) reviewCheckpoint ??= event.checkpoint
  }, read: async () => {
    const page = await read()
    return ++reads === 1 ? page : { ...page, spans: page.spans.map(part => ({ ...part, review: true as const })) }
  } }
  await new PiRuntime(directory).run(input, { ...options, insight })
  const receipts = events.flatMap(event => event.type === 'request' && event.kind === 'inference' ? [event.spans] : [])
  expect(receipts).toEqual([[], [span], [{ ...span, review: true }], []])
  expect(reviewCheckpoint).toBeTruthy()
  await new PiRuntime(directory).run({ ...input, checkpoint: reviewCheckpoint }, { ...options, insight })
  expect(events.filter(event => event.type === 'request').at(-1)?.spans).toEqual([span, { ...span, review: true }])
  const wirePages = requests.flatMap(body => body.input ?? []).filter(item => item.type === 'function_call_output')
  expect(wirePages.every(item => !String(item.output).includes('"review"'))).toBe(true)
}, 30000)

it('从 Chat Completions 工具断点向 Responses 实际重放相配的调用与原文', async () => {
  const { input, options, events, read, span } = sample('周五见。')
  const controller = new AbortController()
  answer = (path, _body, response) => {
    if (path === '/v1/responses') { responses(response, [textItem('已恢复')]); return }
    if (requests.length > 1) { controller.abort(); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call_old', type: 'function', function: { name: 'read_messages', arguments: '{}' } }] }
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
  }
  await expect(new PiRuntime(directory).run({ ...input, model: { ...model, protocol: 'openai-completions' } },
    { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  const checkpoint = events.filter(event => event.type === 'checkpoint').at(-1)!.checkpoint
  const resumed = await new PiRuntime(directory).run({ ...input, checkpoint, prompt: '继续阅读。' }, options)
  expect(resumed.text).toBe('已恢复')
  expect(JSON.parse(resumed.checkpoint).sessionFile).toBe(JSON.parse(checkpoint).sessionFile)
  const request = requests.at(-1)!
  expect(request.store).toBe(false)
  expect(request.previous_response_id).toBeUndefined()
  const call = request.input!.find(item => item.type === 'function_call')!
  const output = request.input!.find(item => item.type === 'function_call_output')!
  expect(call.call_id).toBeTruthy()
  expect(output.call_id).toBe(call.call_id)
  expect(JSON.stringify(output.output)).toContain('周五见。')
  expect(read).toHaveBeenCalledOnce()
  expect(events.filter(event => event.type === 'request').at(-1)?.spans).toEqual([span])
}, 30000)

it('重放真实样本第 27 次请求，将本轮容量留给五个回查目标', async () => {
  const archive = 'docs/research/assets/pi-insights-issue-35'
  const lines = (await readFile(join(archive, '4600/source.txt'), 'utf8')).trimEnd().split(/\r?\n/)
  const processor = createMessageProcessor(defaultProcessing, [])
  const sources = lines.slice(0, 4600).map(line => {
    const [id, at, sender, reply, text] = line.split('\t')
    const isSelf = sender === '合成本人'
    const [protectedSource] = processor.prepare([{ id, text, senderName: sender, memberId: isSelf ? '1' : '2', kind: 'text' }])
    return { id, revision: id, text: protectedSource.text, senderName: protectedSource.senderName, isSelf,
      sentAtMs: Date.parse(at), replyToMessageId: reply.replace('回复 #', '') || null }
  })
  const read = createInsightReader({ taskId: '1', createdAtMs: 0, sourceStartTimeMs: null, sourceEndTimeMs: null,
    scope: { kind: 'all' }, timezone: 'Asia/Shanghai', sources: sources.map(({ id, revision }) => ({ messageId: id, revision })) },
  async ids => ids.map(id => sources[Number(id) - 1]))
  const queries = [['1', 16], ['409', 8], ['434', 0], ['330', 22], ['369', 7]].map(([id, after]) =>
    ({ messageId: String(id), before: 0, after: Number(after) }))
  const { input, options, events } = sample('')
  const wirePages: InsightReadPage[] = []
  let calls = 0
  answer = (_path, body, response) => {
    if (!calls++) {
      responses(response, queries.map((args, i) => ({
        type: 'function_call', id: 'fc_probe' + i, call_id: 'call_probe' + i, name: 'read_messages', arguments: JSON.stringify(args),
      })), 8922, 384)
    } else {
      for (const item of body.input ?? []) {
        if (item.type === 'function_call_output') wirePages.push(JSON.parse(String(item.output)))
      }
      responses(response, [textItem('已核对')])
    }
  }
  await new PiRuntime(directory).run({ ...input, model: { ...model, contextWindow: 16000, maxTokens: 4000 } },
    { ...options, insight: { ...options.insight, read } })
  expect(wirePages.map(page => page.status === 'ok' ? page.messages.map(message => message.id) : page.status))
    .toEqual(queries.map(query => expect.arrayContaining([query.messageId])))
  expect(wirePages.reduce((bytes, page) => bytes + Buffer.byteLength(JSON.stringify(page)), 0)).toBeLessThanOrEqual(2566)
  for (const [index, first] of wirePages.entries()) {
    const query = queries[index]
    const ids = []
    let page = first
    while (page.status === 'ok') {
      ids.push(...page.messages.map(message => message.id))
      if (!page.nextCursor) break
      page = (await read({ cursor: page.nextCursor }, 2566)).page
    }
    expect(ids).toEqual(Array.from({ length: query.after + 1 }, (_, offset) => String(Number(query.messageId) + offset)))
  }
  const coverage = { coveredMessageIds: sources.slice(0, 526).map(source => source.id), partial: {} }
  const receipt = events.filter(event => event.type === 'request' && event.kind === 'inference').at(-1)!
  expect(receipt.spans.length).toBeGreaterThanOrEqual(5)
  expect(addInsightCoverage(coverage, receipt.spans)).toEqual(coverage)
}, 30000)

it('328 字节由两处回查共用时，按原编号单独重试可取全长消息', async () => {
  const { input, options, events } = sample('')
  const sources = ['到'.repeat(6000), '好'].map((text, index) => ({ id: String(index + 1), revision: 'r', text,
    isSelf: true, senderName: 'U1', sentAtMs: 0, replyToMessageId: null }))
  const read = vi.fn(createInsightReader({ taskId: '1', createdAtMs: 0, sourceStartTimeMs: null, sourceEndTimeMs: null,
    scope: { kind: 'all' }, timezone: 'UTC', sources: sources.map(s => ({ messageId: s.id, revision: s.revision })) },
  async ids => ids.map(id => sources[Number(id) - 1])))
  const locate = (id: string) => ({ messageId: id, before: 0, after: 0 })
  const received: InsightReadPage[][] = []
  let turn = 0, sentReads = 0
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) {
      responses(response, [textItem('本次回查 #1 与 #2。')]); return
    }
    const pages = (body.input ?? []).filter(item => item.type === 'function_call_output')
      .slice(-sentReads).map(item => JSON.parse(String(item.output)) as InsightReadPage)
    received.push(pages)
    const last = pages.at(-1)
    const args = turn === 0 ? [locate('1'), locate('2')] : turn === 1 ? [locate('1')]
      : last?.status === 'ok' && last.nextCursor ? [{ cursor: last.nextCursor }] : []
    if (!args.length || turn > 8) { responses(response, [textItem('核查完毕')]); return }
    sentReads = args.length
    const calls = args.map((arg, index) => ({ type: 'function_call', id: `fc_${turn}_${index}`, call_id: `call_${turn}_${index}`,
      name: 'read_messages', arguments: JSON.stringify(arg) }))
    responses(response, calls, turn++ === 0 ? 11532 : 1000)
  }
  await new PiRuntime(directory).run({ ...input, model: { ...model, contextWindow: 16000, maxTokens: 4000 } },
    { ...options, insight: { ...options.insight, read } })
  expect(received[1]).toMatchObject([{ status: 'insufficient_capacity' }, { status: 'ok', messages: [{ id: '2' }] }])
  expect(received.slice(2).flat().flatMap(page => page.status === 'ok' ? page.messages.map(message => message.text) : []).join('')).toBe(sources[0].text)
  const spans = events.flatMap(event => event.type === 'request' ? event.spans : [])
  expect(addInsightCoverage({ coveredMessageIds: [], partial: {} }, spans)).toEqual({ coveredMessageIds: ['2', '1'], partial: {} })
  expect(read.mock.calls.length).toBe(received.flat().length)
  expect(received[1][0]).toMatchObject({ message: expect.stringMatching(/保留顺读游标.*单独/) })
}, 30000)

it('Pi 把成功推理确认的全读进度送入下一次压缩和成稿推理', async () => {
  const { input, options, read } = sample('周五见。'.repeat(2600))
  let reviewed = false, ordinary = 0
  const wire: { compacting: boolean; instruction: string }[] = []
  answer = (_path, body, response) => {
    const instruction = JSON.stringify(body.input?.[0])
    const compacting = instruction.includes('context summarization assistant')
    wire.push({ compacting, instruction })
    if (compacting) { responses(response, [textItem('合成阅读笔记')]); return }
    if (++ordinary > 2) { responses(response, [textItem('已完成报告')]); return }
    responses(response, [{ type: 'function_call', id: 'fc_' + ordinary, call_id: 'call_' + ordinary,
      name: 'read_messages', arguments: JSON.stringify(ordinary === 1 ? {} : { messageId: '1', before: 0, after: 0 }) }], 5800)
  }
  await new PiRuntime(directory).run(input, { ...options, insight: { read, record: async event => {
    if (event.type === 'request' && event.kind === 'inference' && event.success && event.spans.length) reviewed = true
    if (reviewed) return { fullyReviewed: 1 }
  } } })
  expect(wire.filter(r => !r.compacting).map(r => r.instruction.includes('已完整送阅'))).toEqual([false, false, true])
  expect(wire.filter(r => r.compacting).map(r => r.instruction.includes('笔记中记明下一步是成稿'))).toEqual([false, true])
  expect(wire.at(-1)!.instruction).toContain('无须从头顺读')
}, 30000)

it('压缩耗尽输出后从同一断点重开，下一份完整的短摘要才写入会话', async () => {
  const { input, options, events } = sample('约在周五。'.repeat(2600))
  const frozen = { ...input, model: { ...model, contextWindow: 16000, maxTokens: 4000 } }
  const compacting: Request[] = []
  let capped = true, needPage = true
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) {
      compacting.push(body)
      responses(response, [textItem(capped ? '未写完的笔记' : '顺读至 #1，原话改在周五。')], 5601, 4000, capped ? 'incomplete' : 'completed')
    } else if (needPage) {
      needPage = false
      const id = capped ? 'first' : 'resumed'
      responses(response, [{ type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'read_messages', arguments: '{}' }], 7000)
    } else responses(response, [textItem('本轮结束')])
  }
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const first = await new PiRuntime(directory).run(frozen, options)
  const file = JSON.parse(first.checkpoint).sessionFile
  const summaries = () => SessionManager.open(file).getBranch().filter(entry => entry.type === 'compaction')
  const compactionReceipts = () => events.filter(e => e.type === 'request' && e.kind === 'compaction')
  const truncated = compactionReceipts().at(-1)
  expect(truncated).toMatchObject({ stopReason: 'length', usage: { outputTokens: 4000 } })
  expect(events).toContainEqual({ type: 'summary', requestId: truncated!.requestId, saved: false })
  expect(summaries()).toHaveLength(0)

  capped = false
  needPage = true
  const resumed = await new PiRuntime(directory).run({ ...frozen, checkpoint: first.checkpoint, prompt: '继续。' }, options)
  expect(JSON.parse(resumed.checkpoint).sessionFile).toBe(file)
  const completed = compactionReceipts().at(-1)
  expect(completed).toMatchObject({ stopReason: 'stop', usage: { outputTokens: 4000 } })
  expect(events).toContainEqual({ type: 'summary', requestId: completed!.requestId, saved: true })
  expect(summaries()).toContainEqual(expect.objectContaining({ summary: expect.stringContaining('顺读至 #1，原话改在周五。') }))
  const nextInput = JSON.stringify(requests.at(-1)!.input)
  expect(nextInput).toContain('顺读至 #1，原话改在周五。')
  expect(nextInput).not.toContain('未写完的笔记')
  expect(nextInput).not.toContain('900 字')
  expect(compacting.length).toBeGreaterThanOrEqual(2)
  for (const request of compacting) {
    expect(request.max_output_tokens).toBe(4000)
    const instruction = JSON.stringify(request.input?.[0])
    for (const expected of ['900', '替换', '顺读游标', '原文编号', '反例', frozen.systemPrompt]) expect(instruction).toContain(expected)
  }
}, 30000)

it('恢复超出上下文的推理时，以真正阻止恢复的压缩请求归因为认证失败', async () => {
  const { input, options, events } = sample('周五见。'.repeat(2100))
  let reads = 0
  answer = (_path, body, response) => {
    const summary = JSON.stringify(body.input?.[0]).includes('context summarization assistant')
    if (!summary && reads++ === 0) {
      responses(response, [{ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_messages', arguments: '{}' }])
      return
    }
    response.writeHead(summary ? 401 : 400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: summary ? { code: 'invalid_api_key', message: 'Invalid key' }
      : { code: 'context_length_exceeded', message: "This model's maximum context length is 8000 tokens." } }))
  }
  const error = await new PiRuntime(directory).run(input, options).catch(error => error)
  expect(events).toContainEqual(expect.objectContaining({ type: 'request', failureCode: 'MODEL_CONTEXT_LIMIT' }))
  const compaction = events.find(e => e.type === 'request' && e.kind === 'compaction')
  expect(compaction).toMatchObject({ failureCode: 'INSIGHT_AUTH_FAILED', httpStatus: 401 })
  expect(events).toContainEqual({ type: 'summary', requestId: compaction!.requestId, saved: false })
  expect(error).toMatchObject({ code: 'INSIGHT_AUTH_FAILED' })
}, 30000)

it.each(['工具页', '压缩笔记'] as const)('按本轮%s中的中文材料为输出留出实际空间', async kind => {
  const text = '海'.repeat(kind === '工具页' ? 45000 : 1500)
  const { input, options } = sample(kind === '工具页' ? text : 'x'.repeat(4600))
  const task = { ...input, systemPrompt: kind === '压缩笔记' ? text : input.systemPrompt,
    model: { ...model, ...(kind === '工具页' ? { contextWindow: 256000, maxInputTokens: 144000, maxTokens: 128000 }
      : { contextWindow: 16000, maxInputTokens: 4000, maxTokens: 14000 }) } }
  let observed: Request | undefined
  answer = (_path, body, response) => {
    const summary = JSON.stringify(body.input?.[0]).includes('context summarization assistant')
    if (summary) {
      if (kind === '压缩笔记') observed = body
      return responses(response, [textItem('继续阅读')])
    }
    if (requests.length === 1) {
      return responses(response, [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_messages', arguments: '{}' }],
        kind === '工具页' ? 15000 : 2700)
    }
    if (kind === '工具页') observed = body
    responses(response, [textItem('已成稿')])
  }
  await new PiRuntime(directory).run(task, options)
  expect(JSON.stringify(observed?.input)?.includes('海'.repeat(1000))).toBe(true)
  expect(observed?.max_output_tokens).toBeGreaterThan(kind === '工具页' ? 100000 : 1024)
  expect(observed?.max_output_tokens).toBeLessThanOrEqual(kind === '工具页' ? 106000 : 11500)
}, 30000)

it.each([
  { contextWindow: 9000, maxInputTokens: 9000, maxTokens: 4000 },
  { contextWindow: 16000, maxInputTokens: 1000, maxTokens: 4000 },
])('本地拒绝超出输入或上下文的洞察请求时保留断点，且不记一次请求 ($maxInputTokens)', async limits => {
  const { input, options, events } = sample('周五见。')
  answer = (_path, _body, response) => responses(response, [textItem('测试')])
  const task = { ...input, systemPrompt: '海'.repeat(4000), model: { ...model, ...limits } }
  await expect(new PiRuntime(directory).run(task, options)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_LIMIT' })
  expect(requests).toHaveLength(0)
  expect(events.some(event => event.type === 'checkpoint')).toBe(true)
  expect(events.filter(event => event.type !== 'checkpoint')).toEqual([{ type: 'requestBlocked', kind: 'inference', code: 'MODEL_CONTEXT_LIMIT' }])
}, 30000)

const signatureCases = [
  { label: '普通签名', keep: true },
  { label: '已脱敏的正文', text: '密码是[密码]', keep: true },
  { label: '密文不参与文本处理', encrypted: 'opaque@example.invalid', keep: true },
  { label: '正文含邮箱', text: 'fixture.secret@example.invalid', keep: false },
  { label: '正文含带引号的密码字段', text: JSON.stringify({ password: 'synthetic_value' }), keep: false },
  { label: '正文含制表符分隔的令牌', text: 'Bearer\tsynthetic_value', keep: false },
  { label: '未知格式', extra: { unknownPart: '合成内容' }, keep: false },
  { label: '断点签名无法解析', corruptCheckpoint: true, keep: false },
]
it.each([false, true])('Claude 压缩后的签名工具轮次与原文收据按脱敏规则恢复，含邮箱=%s', async sensitive => {
  const { input, options, span, events } = sample('周五两点见。')
  const claude = { ...input, model: { ...model, protocol: 'anthropic-messages' as const } }
  const thinking = { type: 'thinking', thinking: sensitive ? 'fixture.secret@example.invalid' : '回查见面时间。', signature: 'signed-example' }
  const redacted = { type: 'redacted_thinking', data: 'opaque-example' }
  const tool = { type: 'tool_use', id: 'toolu_read', name: 'read_messages', input: {} }
  answer = (_path, _body, response) => {
    const first = requests.length === 1
    const blocks = first ? [thinking, redacted, tool] : [{ type: 'text', text: '已核对。' }]
    const stream = [
      { type: 'message_start', message: { id: 'msg_example', type: 'message', role: 'assistant', model: model.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      ...blocks.flatMap((content_block, index) => [
        { type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } }, { type: 'message_stop' },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(stream.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
  }
  const result = await new PiRuntime(directory).run(claude, options)
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const { sessionFile } = JSON.parse(result.checkpoint)
  const manager = SessionManager.open(sessionFile)
  const page = manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'toolResult')!
  manager.branch(page.id)
  const leafId = manager.appendCompaction('已保存阅读笔记。', null, 5000)
  await new PiRuntime(directory).run({ ...claude, checkpoint: JSON.stringify({ sessionFile, leafId }) }, options)
  const wire = requests.at(-1)!.messages as { role: string; content: unknown }[]
  expect(JSON.stringify(wire)).toContain('周五两点见。')
  if (sensitive) {
    expect(JSON.stringify(requests)).not.toContain(thinking.thinking)
    expect(JSON.stringify(wire)).not.toMatch(/signed-example|opaque-example|tool_use|tool_result/)
  } else {
    const call = wire.findIndex(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use'))
    expect(wire[call].content).toEqual([thinking, redacted, tool])
    expect(wire[call + 1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: tool.id })]))
  }
  expect(events.filter(event => event.type === 'request').at(-1)?.spans).toEqual([span])
}, 30000)

it.each(signatureCases)('压缩后按脱敏设置重放工具与推理配对：$label', async ({ text, encrypted = 'opaque-example', extra, corruptCheckpoint, keep }) => {
  const { input, options, events, span } = sample('合成原文。'.repeat(1800))
  let ordinaryRequests = 0
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) {
      responses(response, [textItem('已保存阅读位置')]); return
    }
    if (++ordinaryRequests > 1) { responses(response, [textItem('已成稿')]); return }
    const reasoning = { type: 'reasoning', id: 'rs_example', summary: [{ type: 'summary_text', text: '需要查阅原话。' }],
      ...(text && { content: [{ type: 'reasoning_text', text }] }), encrypted_content: encrypted, ...extra }
    responses(response, [reasoning, { type: 'function_call', id: 'fc_example', call_id: 'call_page', name: 'read_messages', arguments: '{}' }], 5800)
  }
  const result = await new PiRuntime(directory).run(input, options)
  expect(result.text).toBe('已成稿')
  expect(events.some(event => event.type === 'request' && event.kind === 'compaction')).toBe(true)
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const { sessionFile } = JSON.parse(result.checkpoint)
  const manager = SessionManager.open(sessionFile)
  const page = manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'toolResult')!
  manager.branch(page.id)
  if (corruptCheckpoint) {
    const turn = manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'assistant')!
    if (turn.type !== 'message' || turn.message.role !== 'assistant' || page.type !== 'message') throw Error('缺少合成工具回合')
    manager.branch(turn.parentId)
    manager.appendMessage({ ...turn.message, content: turn.message.content.map(block => block.type === 'thinking'
      ? { ...block, thinkingSignature: '{broken-fixture' } : block) })
    manager.appendMessage(page.message)
  }
  const leafId = manager.appendCompaction('已保存阅读位置', null, 5800)
  expect(manager.buildSessionContext().messages.some(message => message.role === 'toolResult')).toBe(false)
  await new PiRuntime(directory).run({ ...input, checkpoint: JSON.stringify({ sessionFile, leafId }) }, options)
  const inputItems = requests.at(-1)!.input!
  const call = inputItems.find(item => item.type === 'function_call')!
  const output = inputItems.find(item => item.type === 'function_call_output')!
  expect(output.call_id).toBe(call.call_id)
  expect(JSON.stringify(output.output)).toContain('合成原文。')
  const reasoning = inputItems.find(item => item.type === 'reasoning')
  if (!keep) {
    expect(reasoning).toBeUndefined()
    expect(call.id).toBeUndefined()
    if (text) expect(JSON.stringify(requests)).not.toContain(text.includes('synthetic_value') ? 'synthetic_value' : text)
    expect(JSON.stringify(inputItems)).not.toContain(encrypted)
  } else {
    expect(reasoning).toMatchObject({ id: 'rs_example', encrypted_content: encrypted })
    expect(call.id).toBe('fc_example')
    expect(inputItems.indexOf(reasoning!)).toBeLessThan(inputItems.indexOf(call))
  }
  expect(events.filter(event => event.type === 'request').at(-1)?.spans).toEqual([span])
}, 30000)


it.each(['openai-responses', 'anthropic-messages'] as const)('额度失败后更换服务商使用 %s 接续同一原文断点，移除旧签名', async protocol => {
  const { input, options, events, read, span } = sample('示例原文：周五两点见。')
  input.model = { ...model, contextWindow: 16000 }
  answer = (_path, _body, response) => {
    if (requests.length === 1) responses(response, [
      { type: 'reasoning', id: 'rs_old', summary: [{ type: 'summary_text', text: '需要回查。' }], encrypted_content: 'old-provider-ciphertext' },
      { type: 'function_call', id: 'fc_old', call_id: 'call_old', name: 'read_messages', arguments: '{}' },
    ])
    else {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Quota exceeded' } }))
    }
  }
  await expect(new PiRuntime(directory).run(input, options)).rejects.toMatchObject({ code: 'INSIGHT_QUOTA_EXCEEDED' })
  const checkpoint = events.filter(event => event.type === 'checkpoint').at(-1)!.checkpoint
  const requestCount = requests.length
  answer = (path, _body, response) => {
    if (protocol === 'openai-responses') { responses(response, [textItem('已接续')]); return }
    expect(new URL(path, 'http://localhost').pathname).toBe('/v1/messages')
    const stream = [
      { type: 'message_start', message: { id: 'msg_new', type: 'message', role: 'assistant', model: model.model, content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '已接续' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(stream.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
  }
  const resumed = await new PiRuntime(directory).run({ ...input, checkpoint, model: { ...model, id: 'other-provider', protocol },
    insightSession: { ...input.insightSession, modelSessionKey: JSON.stringify(['other-provider', 1]) }, prompt: '继续剩余分析。' }, options)
  expect(resumed.text).toBe('已接续')
  expect(JSON.parse(resumed.checkpoint).sessionFile).toBe(JSON.parse(checkpoint).sessionFile)
  const wire = JSON.stringify(requests.slice(requestCount))
  expect(wire).toContain('示例原文：周五两点见。')
  expect(wire).not.toContain('old-provider-ciphertext')
  expect(read).toHaveBeenCalledOnce()
  expect(events.filter(event => event.type === 'request').at(-1)?.spans).toEqual([span])
}, 30000)


it('替换模型窗口不足以压缩已有历史时明确报错，原断点可继续恢复', async () => {
  const { input, options, events, read } = sample('合成原文，约好周五见。'.repeat(600))
  const large = { ...input, model: { ...model, contextWindow: 64000, maxTokens: 1000 } }
  answer = (_path, _body, response) => responses(response, requests.length === 1
    ? [{ type: 'function_call', id: 'fc_long', call_id: 'call_long', name: 'read_messages', arguments: '{}' }]
    : [textItem('已保存阅读笔记。')])
  const first = await new PiRuntime(directory).run(large, options)
  const priorEvents = events.length
  const requestCount = requests.length
  await expect(new PiRuntime(directory).run({ ...input, checkpoint: first.checkpoint,
    model: { ...model, id: 'tiny', contextWindow: 2048, maxInputTokens: 1200, maxTokens: 800 },
    insightSession: { ...input.insightSession, modelSessionKey: 'tiny' } }, options)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_LIMIT' })
  expect(events.slice(priorEvents)).toContainEqual({ type: 'requestBlocked', kind: expect.stringMatching(/inference|compaction/), code: 'MODEL_CONTEXT_LIMIT' })
  expect(requests.length).toBe(requestCount)
  const resumed = await new PiRuntime(directory).run({ ...large, checkpoint: first.checkpoint, prompt: '继续成稿。' }, options)
  expect(resumed.text).toBe('已保存阅读笔记。')
  expect(JSON.parse(resumed.checkpoint).sessionFile).toBe(JSON.parse(first.checkpoint).sessionFile)
  expect(read).toHaveBeenCalledOnce()
  expect(JSON.stringify(requests.at(-1))).toContain('合成原文，约好周五见。')
}, 30000)
