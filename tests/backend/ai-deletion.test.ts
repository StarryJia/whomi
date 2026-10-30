import { expect, test, vi } from 'vitest'
import { createAiService, type RuntimeRunner } from '../../electron/main/ai-service'
import type { AiTurn, AnalysisTask } from '../../src/shared/ai-contract'

const model = { id: 'm', label: '本地测试模型', model: 'm', baseUrl: 'http://127.0.0.1:9', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
function fixture(runtime: RuntimeRunner, beforeResponse?: (method: string) => Promise<void>) {
  const turns = new Map<string, AiTurn>()
  const analysis: AnalysisTask = { id: '1', conversationId: '1', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  let deleted = false
  const lateWrites: string[] = []
  const service = createAiService({ runtime, secrets: { encrypt: text => text, decrypt: text => text }, storage: async (method, args) => {
    if (deleted && ['saveTurn', 'saveAnalysis', 'recordUsage', 'commitBatch', 'completeAnalysis'].includes(method)) lateWrites.push(method)
    if (method === 'getThread') return { id: args[0], conversationId: args[0], turns: [...turns.values()].filter(turn => turn.threadId === args[0]) }
    if (method === 'createTurn') {
      const input = args[0] as { threadId: string; requestId: string; prompt: string }
      const turn: AiTurn = { id: input.requestId, threadId: input.threadId, requestId: input.requestId, prompt: input.prompt, referenceIds: [], modelId: 'm', text: '', state: 'queued', attempt: 1, usage: {}, eventSequence: 1 }
      turns.set(turn.id, turn)
      await beforeResponse?.(method)
      return turn
    }
    if (method === 'turnContext') {
      const turn = turns.get(args[0] as string)!
      return { turn, conversationId: turn.threadId, model, selfFingerprint: 'self', references: [], history: [], profile: null, skill: null, checkpoint: null }
    }
    if (method === 'saveTurn') return Object.assign(turns.get(args[0] as string)!, args[1])
    if (method === 'confirmAnalysis' || method === 'resumeAnalysis') { analysis.state = 'queued'; await beforeResponse?.(method); return analysis }
    if (method === 'getAnalysis') return analysis
    if (method === 'beginRetryTurn') { const turn = turns.get(args[0] as string)!; turn.state = 'queued'; await beforeResponse?.(method); return turn }
    if (method === 'analysisContext') return { task: analysis, model, selfFingerprint: 'self', messages: [{ id: '1', text: '测试正文', senderName: '本人', isSelf: true, kind: 'text' }], batches: [], checkpoint: null }
    if (method === 'saveAnalysis') return Object.assign(analysis, args[1])
    if (method === 'modelSecret') return { model, encryptedKey: null }
    if (method === 'recordUsage') return {}
    if (method === 'recover') return undefined
    throw new Error(method)
  } })
  return { service, lateWrites, turns, analysis, markDeleted() { deleted = true } }
}
const send = (threadId: string, requestId = threadId) => ({ threadId, requestId, prompt: '测试问题', referenceIds: [], modelId: 'm' })

test.each(['turn', 'analysis'])('delete stops a running %s before removing its data', async kind => {
  let signal: AbortSignal | undefined
  const state = fixture({ run: async (_input, options) => {
    signal = options.signal
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }))
  } })
  if (kind === 'turn') await state.service.sendTurn(send('1'))
  else await state.service.confirmAnalysis({ token: 'token', requestId: 'analysis' })
  await vi.waitFor(() => expect(signal).toBeDefined())
  const remove = vi.fn(async () => { expect(signal!.aborted).toBe(true); state.markDeleted() })
  await state.service.deleteConversation('1', remove)
  expect(remove).toHaveBeenCalledOnce()
  await state.service.idle()
  expect(state.lateWrites).toEqual([])
})

test('deleting a queued conversation does not wait for or stop a different conversation', async () => {
  let release!: (value: { text: string; usage: {}; checkpoint: string }) => void
  let runningSignal: AbortSignal | undefined
  const run = vi.fn(async (_input, options) => {
    runningSignal = options.signal
    return await new Promise<any>(resolve => { release = resolve })
  })
  const state = fixture({ run })
  await state.service.sendTurn(send('2'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  await state.service.sendTurn(send('1'))
  const remove = vi.fn(async () => {})
  const deletion = state.service.deleteConversation('1', remove)
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
  expect(runningSignal!.aborted).toBe(false)
  release({ text: '其他会话的正常回答', usage: {}, checkpoint: 'cp' })
  await deletion
  await state.service.idle()
  expect(run).toHaveBeenCalledTimes(1)
})

test('new work waits for deletion persistence and a failed removal releases the lifecycle queue', async () => {
  const state = fixture({ run: async () => ({ text: '回答', usage: {}, checkpoint: 'cp' }) })
  let rejectRemoval!: (error: Error) => void
  let removing = false
  const deletion = state.service.deleteConversation('1', async () => {
    removing = true
    await new Promise<void>((_resolve, reject) => { rejectRemoval = reject })
  })
  await vi.waitFor(() => expect(removing).toBe(true))
  const pending = state.service.sendTurn(send('1'))
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(state.turns.size).toBe(0)
  rejectRemoval(new Error('disk failure'))
  await expect(deletion).rejects.toThrow('disk failure')
  await pending
  await state.service.idle()
})

test.each(['confirmAnalysis', 'resumeAnalysis', 'createTurn', 'beginRetryTurn'])('deletion waits for %s persistence and leaves a recoverable task when removal fails', async method => {
  let release!: () => void
  let persisted = false
  const state = fixture({ run: async (_input, options) => await new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })
  }) }, async name => {
    if (name === method) { persisted = true; await new Promise<void>(resolve => { release = resolve }) }
  })
  if (method === 'beginRetryTurn') state.turns.set('1', { id: '1', threadId: '1', requestId: '1', prompt: '测试问题', referenceIds: [], modelId: 'm', text: '', state: 'stopped', attempt: 1, usage: {}, eventSequence: 1 })
  if (method === 'resumeAnalysis') state.analysis.state = 'stopped'
  const starting = method === 'confirmAnalysis' ? state.service.confirmAnalysis({ token: 'token', requestId: '1' })
    : method === 'resumeAnalysis' ? state.service.continueAnalysis('1')
    : method === 'createTurn' ? state.service.sendTurn(send('1')) : state.service.retryTurn('1')
  const outcome = starting.then(() => null, error => error)
  await vi.waitFor(() => expect(persisted).toBe(true))
  const remove = vi.fn(async () => { throw new Error('disk failure') })
  const deletion = state.service.deleteConversation('1', remove).catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(remove).not.toHaveBeenCalled()
  release()
  expect(await outcome).toBeNull()
  expect(await deletion).toHaveProperty('message', 'disk failure')
  expect(method.endsWith('Analysis') ? state.analysis.state : state.turns.get('1')!.state).toBe('stopped')
  expect(state.lateWrites).toEqual([])
})

test('closing drains accepted setup before recovery and rejects newly submitted controls', async () => {
  let release!: () => void
  let persisted = false
  const run = vi.fn(async () => ({ text: '回答', usage: {}, checkpoint: 'cp' }))
  const state = fixture({ run }, async method => {
    if (method === 'createTurn') { persisted = true; await new Promise<void>(resolve => { release = resolve }) }
  })
  const starting = state.service.sendTurn(send('1'))
  await vi.waitFor(() => expect(persisted).toBe(true))
  const closing = state.service.close()
  const newRequest = state.service.sendTurn(send('2')).then(() => null, error => error)
  release()
  await starting
  await closing
  expect(await newRequest).toHaveProperty('code', 'AI_CLOSED')
  expect(state.turns.has('2')).toBe(false)
  expect(run).not.toHaveBeenCalled()
})
