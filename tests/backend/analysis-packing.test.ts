import { expect, test } from 'vitest'
import { createAiService, type RuntimeInput } from '../../electron/main/ai-service'
import { createMessageProcessor } from '../../electron/main/message-processing'
import { defaultProcessing } from '../../src/shared/settings-contract'
import type { AiModel, AnalysisTask } from '../../src/shared/ai-contract'

const model: AiModel = { id: 'fixture', label: '虚构', model: 'fixture', baseUrl: 'http://localhost', contextWindow: 128000, maxTokens: 8192, maxInputTokens: 128000, enabled: true, version: 1, hasCredential: false }
function messages(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: String(i + 1), senderName: i % 2 ? '乙' : '甲', text: '好', isSelf: !(i % 2),
    kind: 'text', sentAtMs: 1600000000000 + i * 1000, memberId: i % 2 ? '2' : '1' }))
}
const savedNote = { events: [{ key: '示例', text: '确认时间。', evidenceMessageIds: ['1'], signals: [] }] }
type Saved = { index: number; messageIds: string[]; report: typeof savedNote; usage: {} }
async function run(source: ReturnType<typeof messages>, saved: Saved[] = [], configured = model, merge = false, override?: (input: RuntimeInput) => unknown) {
  const covered = new Set(saved.flatMap(item => item.messageIds))
  const task: AnalysisTask = { id: '1', modelId: configured.id, conversationId: '1', state: 'queued', analyzedMessages: covered.size,
    totalMessages: source.length, skippedMessages: 0, usage: {}, valid: true, eventSequence: 0 }
  const requests: { id: string; text: string; sourceIds: string[]; isSelf: boolean }[][] = [], costs: number[] = []
  let checkpoint = null
  const service = createAiService({ storage: async (method, args) => {
    if (method === 'getAnalysis' || method === 'confirmAnalysis' || method === 'recordUsage') return task
    if (method === 'analysisContext') return { task, model: configured, selfFingerprint: 'test', messages: source, batches: saved, checkpoint, promptVersion: 'conversation-memory-v3' }
    if (method === 'modelSecret') return { model: configured, encryptedKey: null }
    if (method === 'saveAnalysis') { const patch = args[1] as any; if (patch.checkpoint !== undefined) checkpoint = patch.checkpoint; return Object.assign(task, patch) }
    if (method === 'commitBatch') { const batch = args[1] as Saved; saved.push(batch); for (const id of batch.messageIds) covered.add(id); task.analyzedMessages = covered.size; return task }
    if (method === 'completeAnalysis') { task.state = 'completed'; return task }
    throw Error(method)
  }, processing: async () => ({ settings: { ...defaultProcessing, anonymize: false, merge }, members: [] }),
  runtime: { run: async input => {
    costs.push(Buffer.byteLength(input.systemPrompt + input.prompt + JSON.stringify(input.history ?? [])) + 1000)
    const payload = JSON.parse(input.prompt)
    if (payload.messages) requests.push(payload.messages)
    const result = payload.messages ? { events: [{ key: '示例', text: '确认时间。', evidenceMessageIds: [payload.messages[0].id], signals: [] }] }
      : { groups: [['示例']], events: [{ key:'示例', title:'见面', text:'两人确认了时间。' }], relationship:'你们一起商量。' }
    return { text: JSON.stringify(override?.(input) ?? result), usage: {}, checkpoint: '' }
  } }, secrets: { encrypt: String, decrypt: String } })
  await service.confirmAnalysis({ token: 't', requestId: 'r' })
  await service.idle()
  return { task, requests, costs, covered }
}

test('14,639 short messages fit the final serialized envelope and every source is committed once', async () => {
  const source = messages(14639)
  const result = await run(source)
  expect(result.task).toMatchObject({ state: 'completed', analyzedMessages: source.length })
  expect(result.requests.flatMap(batch => batch.flatMap(item => item.sourceIds))).toEqual(source.map(item => item.id))
  expect(Math.max(...result.costs)).toBeLessThanOrEqual(119808)
})

test('a saved 0.1.7 source prefix is reused when the following densely packed batch exceeds the original preflight', async () => {
  const source = messages(14639)
  const ids = source.slice(0,892).map(item => item.id)
  const result = await run(source, [{ index: 0, messageIds: ids, report: savedNote, usage: {} }])
  expect(result.task).toMatchObject({ state: 'completed', analyzedMessages: source.length })
  expect(result.requests.flatMap(batch => batch.flatMap(item => item.sourceIds))).toEqual(source.slice(892).map(item => item.id))
})

test('a long run of contiguous messages sends only the identifiers belonging to each fragment', async () => {
  const source = messages(2000).map(item => ({ ...item, text: '['+item.id+']', isSelf: true, memberId: '1', senderName: '甲' }))
  const result = await run(source, [], { ...model, maxInputTokens: 4000 }, true)
  expect(result.task).toMatchObject({ state: 'completed', analyzedMessages: source.length })
  for (const item of result.requests.flat()) expect(item.sourceIds).toEqual([...item.text.matchAll(/\[(\d+)\]/g)].map(match => match[1]))
})

test('a stored 0.1.7 fragment inside a merged message resumes after the exact Unicode boundary despite zero committed message ids', async () => {
  const texts = ['甲'.repeat(400),'😀'.repeat(450),'乙'.repeat(320)]
  const source = messages(3).map((item, i) => ({ ...item, isSelf: true, senderName: '甲', memberId: '1', text: texts[i] }))
  // 0.1.7 的第一片含全部 甲 和前 214 个表情，但编号只会在合并消息末片提交。
  const result = await run(source, [{ index: 0, messageIds: [], report: savedNote, usage: {} }], { ...model, maxInputTokens: 4000 }, true)
  expect(result.task).toMatchObject({ state: 'completed', analyzedMessages: 3 })
  expect(result.requests.flat().map(item => item.text).join('\n')).toBe('😀'.repeat(236) + '\n' + texts[2])
  expect(result.requests.flatMap(batch => batch.flatMap(item => item.sourceIds))).toEqual(['2','3'])
})

test('old memory summary checkpoints retain their node indices without requesting any source or saved merge node', async () => {
  const source = messages(3).map(item => ({ ...item, text: 'a'.repeat(1400) }))
  const notes = (key: string, id: string, text: string) => ({ events: [{ key, text, evidenceMessageIds: [id], signals: [] }] })
  const saved: Saved[] = source.map((item, i) => ({ index: i, messageIds: [item.id], report: notes(item.id, item.id, 'b'.repeat(1500)), usage: {} }))
  saved.push({ index: 3, messageIds: [], report: notes('1', '1', '旧归并已提交'), usage: {} })
  const merges: string[] = []
  const result = await run(source, saved, { ...model, maxInputTokens: 4000 }, false, input => {
    const { events } = JSON.parse(input.prompt)
    if (input.systemPrompt.includes('压缩共同事件')) {
      merges.push(events[0].key)
      return { groups: [[events[0].key]], events: [{ key: events[0].key, text: '缩写' }] }
    }
    return { groups: events.map((event: {key:string}) => [event.key]), events: [{ key: '1', title: '旧记录', text: '旧归并已提交' }], relationship: '一起商量。' }
  })
  expect(result.task.state).toBe('completed')
  expect(result.requests).toEqual([])
  expect(merges).toEqual(['2','3'])
})

test.each([['source','原文分片'],['merge','事件归并'],['final','文稿撰写']])('service input rejection identifies the %s stage and does not repeat the request', async (stage, label) => {
  const source = messages(3).map(item => ({ ...item, text: 'a'.repeat(1400) }))
  let rejected = 0
  const result = await run(source, [], { ...model, maxInputTokens: 4000 }, false, input => {
    const payload = JSON.parse(input.prompt)
    const current = payload.messages ? 'source' : input.systemPrompt.includes('压缩共同事件') ? 'merge' : 'final'
    if (current === stage) { rejected++; throw Object.assign(Error('untrusted provider content'), { code:'MODEL_CONTEXT_LIMIT' }) }
    if (payload.messages && stage === 'merge') {
      const id = payload.messages[0].id
      return { events: [{ key:id, text:'b'.repeat(1400), evidenceMessageIds:[id], signals:[] }] }
    }
    return undefined
  })
  expect(rejected).toBe(1)
  expect(result.task).toMatchObject({state:'failed',error: expect.stringContaining(label)})
  expect(result.task.error).toContain('模型服务')
  expect(result.task.error).not.toContain('untrusted')
})

test('a missing member identifier cannot borrow the preceding author identity through an equal display name', () => {
  const source = messages(2)
  const processed = createMessageProcessor({ ...defaultProcessing, anonymize: false }, []).messages([
    source[0], { ...source[1], senderName: source[0].senderName, memberId: null },
  ])
  expect(processed.map(item => [item.isSelf, item.sourceIds])).toEqual([[true,['1']],[false,['2']]])
})
