import { expect, test } from 'vitest'
import { createAiService } from '../../electron/main/ai-service'
import type { AnalysisTask } from '../../src/shared/ai-contract'

test('preparing and duplicate confirmation do not duplicate a model run; completion waits for report storage', async () => {
  let runs = 0, release: (value: unknown) => void = () => {}, completed = false
  const task: AnalysisTask = { id: '1', conversationId: '1', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  const storage = async (method: string, args: unknown[]) => {
    if (method === 'prepareAnalysis') return { token: 'token', conversationId: '1', title: '示例', selfName: '我', totalMessages: 1, analyzableMessages: 1, snapshotMaxId: '1', expiresAt: Date.now() + 10000, model }
    if (method === 'confirmAnalysis' || method === 'getAnalysis') return { ...task }
    if (method === 'analysisContext') return { task: { ...task }, model, selfFingerprint: 'self-v1', messages: [{ id: '1', text: '明天听你讲', senderName: '我', isSelf: true, kind: 'text' }], batches: [], checkpoint: null }
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'saveAnalysis') { Object.assign(task, args[1]); return { ...task } }
    if (method === 'commitBatch') { task.analyzedMessages = 1; return { ...task } }
    if (method === 'completeAnalysis') { completed = true; throw new Error('disk full') }
    if (method === 'recordUsage') return {}
    throw new Error(method)
  }
  const service = createAiService({ storage, runtime: { run: async () => { runs++; return await new Promise<any>(resolve => { release = resolve }) } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.prepareAnalysis({ conversationId: '1', modelId: 'm' })
  expect(runs).toBe(0)
  await service.confirmAnalysis({ token: 'token', requestId: 'same' })
  await service.confirmAnalysis({ token: 'token', requestId: 'same' })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(runs).toBe(1)
  release({ text: JSON.stringify({ summary: '示例观察', observations: [{ text: '提供具体帮助', evidenceMessageIds: ['1'], limitations: '仅限本段' }], limitations: '材料有限' }), usage: { outputTokens: 50 }, checkpoint: 'checkpoint' })
  await new Promise(resolve => setTimeout(resolve, 10))
  // 单批仍需最终汇总；两次请求使用同一验证后的结构。
  if (!completed && runs === 2) release({ text: JSON.stringify({ summary: '示例观察', observations: [], limitations: '材料有限' }), usage: {}, checkpoint: 'cp-final' })
  await service.idle()
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

function turnStorage() {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  const turn = { id: '1', threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm', text: '', state: 'queued', attempt: 1, usage: {}, eventSequence: 1 }
  let identityChanged = false
  return { turn, changeIdentity() { identityChanged = true }, async storage(method: string, args: unknown[]) {
    if (method === 'createTurn') return turn
    if (method === 'beginRetryTurn') { turn.attempt++; turn.state = 'queued'; return turn }
    if (method === 'turnContext') { if (identityChanged) throw new Error('identity changed'); return { turn, conversationId: '1', model, selfFingerprint: 'self', references: [], history: [], profile: null, skill: null, checkpoint: null } }
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'saveTurn') return Object.assign(turn, args[1])
    if (method === 'recordUsage') return turn
    throw new Error(method)
  } }
}
test('stopping and retrying before the old response settles still schedules the new attempt', async () => {
  const state = turnStorage()
  let release: (value: any) => void = () => {}, runs = 0
  const service = createAiService({ storage: state.storage, runtime: { run: async () => { runs++; if (runs === 1) return new Promise(resolve => { release = resolve }); return { text: '新回答', usage: {}, checkpoint: 'new' } } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.sendTurn({ threadId: '1', requestId: 'request', prompt: '问题', referenceIds: [], modelId: 'm' })
  await new Promise(resolve => setTimeout(resolve, 5))
  await service.stopTurn('1')
  await service.retryTurn('1')
  release({ text: '旧回答', usage: {}, checkpoint: 'old' })
  await service.idle()
  expect(runs).toBe(2)
  expect(state.turn.text).toBe('新回答')
  expect(state.turn.state).toBe('completed')
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

test('long analysis merges bounded report groups rather than failing after all source batches complete', async () => {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://127.0.0.1:9999/v1', contextWindow: 4096, maxTokens: 512, version: 1, enabled: true, hasCredential: false }
  const task: AnalysisTask = { id: '1', conversationId: '1', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 24, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  const messages = Array.from({ length: 24 }, (_, index) => ({ id: String(index + 1), senderName: '本人', text: 'a'.repeat(1100), isSelf: true, kind: 'text' }))
  const covered = new Set<string>(), saved: any[] = []
  let requests = 0
  const service = createAiService({ storage: async (method, args) => {
    if (method === 'confirmAnalysis' || method === 'getAnalysis') return task
    if (method === 'analysisContext') return { task, model, selfFingerprint: 'self', messages, batches: saved, checkpoint: null }
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'saveAnalysis') return Object.assign(task, args[1])
    if (method === 'recordUsage') return task
    if (method === 'commitBatch') { const batch = args[1] as any; saved.push(batch); batch.messageIds.forEach((id: string) => covered.add(id)); task.analyzedMessages = covered.size; return task }
    if (method === 'completeAnalysis') { task.state = 'completed'; task.report = args[1] as any; return task }
    throw new Error(method)
  }, runtime: { run: async input => {
    requests++
    const source = input.prompt.startsWith('{') ? JSON.parse(input.prompt).messages : undefined
    return { text: JSON.stringify({ summary: source ? 's'.repeat(300) : '合并观察', observations: [{ text: '观察', evidenceMessageIds: [source?.[0]?.id ?? '1'], limitations: '范围有限' }], limitations: '仅限材料' }), usage: {}, checkpoint: 'cp' }
  } }, secrets: { encrypt: value => value, decrypt: value => value } })
  await service.confirmAnalysis({ token: 't', requestId: 'r' })
  await service.idle()
  expect(task.state).toBe('completed')
  expect(task.analyzedMessages).toBe(24)
  expect(requests).toBeGreaterThan(25)
  expect(saved.filter(batch => !batch.messageIds.length).length).toBeGreaterThan(0)
})
