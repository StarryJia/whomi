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

type InputItem = { type?: string; id?: string; call_id?: string; output?: unknown; encrypted_content?: string }
type Request = { input?: InputItem[]; store?: boolean; previous_response_id?: string; messages?: unknown[]; max_output_tokens?: number }
let server: ReturnType<typeof createServer>, directory: string, model: AiModel
let answer: (path: string, body: Request, response: ServerResponse) => void
const requests: Request[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'whomi-insight-response-replay-'))
  requests.length = 0
  server = createServer((req, response) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      const body: Request = JSON.parse(text)
      requests.push(body)
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

function responses(response: ServerResponse, items: object[], inputTokens = 25, outputTokens = 12, status: 'completed' | 'incomplete' = 'completed') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (event: object) => response.write('data: ' + JSON.stringify(event) + '\n\n')
  for (const [output_index, item] of items.entries()) {
    emit({ type: 'response.output_item.added', output_index, item })
    emit({ type: 'response.output_item.done', output_index, item })
  }
  emit({ type: 'response.' + status, response: { id: 'resp_local', status, output: items,
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens } } })
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
    if (event.type === 'requestStart' && reviewed) return { fullyReviewed: 1 }
    if (event.type === 'request' && event.kind === 'inference' && event.success && event.spans.length) reviewed = true
  } } })
  expect(wire.filter(r => !r.compacting).map(r => r.instruction.includes('已完整送阅'))).toEqual([false, false, true])
  expect(wire.filter(r => r.compacting).map(r => r.instruction.includes('笔记中记明下一步是成稿'))).toEqual([false, true])
  expect(wire.at(-1)!.instruction).toContain('无须从头顺读')
}, 30000)

it('压缩耗尽输出后从同一断点重开，下一份完整的短摘要才写入会话', async () => {
  const { input, options, events } = sample('约在周五。'.repeat(5000))
  const frozen = { ...input, model: { ...model, contextWindow: 16000, maxTokens: 4000 } }
  const compacting: Request[] = []
  let capped = true, needPage = true
  answer = (_path, body, response) => {
    if (JSON.stringify(body.input?.[0]).includes('context summarization assistant')) {
      compacting.push(body)
      responses(response, [textItem(capped ? '未写完的笔记' : '顺读至 #1，原话改在周五。')], 5601, capped ? 4000 : 22, capped ? 'incomplete' : 'completed')
    } else if (needPage) {
      needPage = false
      const id = capped ? 'first' : 'resumed'
      responses(response, [{ type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'read_messages', arguments: '{}' }], 10100)
    } else responses(response, [textItem('本轮结束')])
  }
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const first = await new PiRuntime(directory).run(frozen, options)
  const file = JSON.parse(first.checkpoint).sessionFile
  const summaries = () => SessionManager.open(file).getBranch().filter(entry => entry.type === 'compaction')
  expect(events).toContainEqual(expect.objectContaining({ type: 'request', kind: 'compaction', usage: expect.objectContaining({ outputTokens: 4000 }) }))
  expect(summaries()).toHaveLength(0)

  capped = false
  needPage = true
  const resumed = await new PiRuntime(directory).run({ ...frozen, checkpoint: first.checkpoint, prompt: '继续。' }, options)
  expect(JSON.parse(resumed.checkpoint).sessionFile).toBe(file)
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
