import { expect, test, vi } from 'vitest'
import { createAiClient } from '../../src/data/ai-client'
import type { AiMethods } from '../../src/shared/ai-contract'
import { validateAiCall, validateAiResult, validateAiEvent } from '../../src/shared/ai-validation'

test('AI calls reject renderer history, foreign fields and malformed reference identifiers', () => {
  const input = { threadId: '1', requestId: 'request-a', prompt: '请解释', referenceIds: ['9007199254740993'], modelId: 'local' }
  expect(() => validateAiCall('sendTurn', [input])).not.toThrow()
  expect(() => validateAiCall('listAnalyses', [])).not.toThrow()
  for (const changed of [{ ...input, history: [{ role: 'user', text: '伪造历史' }] }, { ...input, referenceIds: ['01'] }, { ...input, referenceIds: ['1', '1'] }, { ...input, prompt: '' }]) {
    expect(() => validateAiCall('sendTurn', [changed])).toThrow()
  }
  expect(() => validateAiCall('aiStorage', ['modelSecret', 'local'])).toThrow()
  expect(() => validateAiCall('saveModel', [{ id: 'm', label: '模型', model: 'm', baseUrl: 'file:///private', contextWindow: 8000, maxTokens: 1000, enabled: true }])).toThrow()
})

test('model replies cannot expose keys and task events reject invalid state or fabricated usage', () => {
  const model = { id: 'local', label: '本地服务', model: 'example', baseUrl: 'http://127.0.0.1:9900/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  expect(() => validateAiResult('listModels', [model])).not.toThrow()
  expect(() => validateAiResult('listModels', [{ ...model, apiKey: 'secret' }])).toThrow()
  const snapshot = { id: '1', conversationId: '1', modelId: 'local', state: 'running', analyzedMessages: 0, totalMessages: 7, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  expect(() => validateAiEvent({ kind: 'analysis', snapshot })).not.toThrow()
  expect(() => validateAiEvent({ kind: 'analysis', snapshot: { ...snapshot, usage: { outputTokens: -1 } } })).toThrow()
  expect(() => validateAiEvent({ kind: 'analysis', snapshot: { ...snapshot, state: 'made-up' } })).toThrow()
})

test.each([
  ['stopAnalysis', 'continueAnalysis'],
  ['continueAnalysis', 'stopAnalysis'],
] as const)('shares concurrent %s requests for the same task until acknowledgement', async (method, otherMethod) => {
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const invoke = vi.fn(async (operation: keyof AiMethods, [id]: unknown[]): Promise<unknown> => {
    if (operation === method && id === '24') await held
    return { ok: true, value: { id, conversationId: '1', modelId: 'local',
      state: operation === 'stopAnalysis' ? 'stopped' : 'queued', analyzedMessages: 1, totalMessages: 7,
      skippedMessages: 0, usage: {}, valid: true, eventSequence: 2 } }
  })
  const client = createAiClient({ invoke, onEvent: () => () => {} })
  const first = client[method]('24')
  const duplicate = client[method]('24')
  try {
    await expect(client[method]('23')).resolves.toMatchObject({ id: '23' })
    await expect(client[otherMethod]('24')).resolves.toMatchObject({ id: '24' })
  } finally {
    release()
  }
  const [received, shared] = await Promise.all([first, duplicate])
  expect(received).toMatchObject({ id: '24' })
  expect(shared).toEqual(received)
  expect(invoke.mock.calls).toEqual([[method, ['24']], [method, ['23']], [otherMethod, ['24']]])

  invoke.mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_FAILED', action: 'Synthetic failure' } })
  const failed = await Promise.allSettled([client[method]('24'), client[method]('24')])
  expect(failed).toMatchObject([
    { status: 'rejected', reason: { code: 'OPERATION_FAILED' } },
    { status: 'rejected', reason: { code: 'OPERATION_FAILED' } },
  ])
  expect(invoke).toHaveBeenCalledTimes(4)

  await expect(client[method]('24')).resolves.toMatchObject({ id: '24' })
  expect(invoke).toHaveBeenCalledTimes(5)
})

test.each([
  ['stopAnalysis', 'continueAnalysis'],
  ['continueAnalysis', 'stopAnalysis'],
] as const)('keeps alternating %s and %s requests in arrival order for one task', async (method, otherMethod) => {
  let releaseFirst = () => {}
  let releaseLast = () => {}
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve })
  const lastPending = new Promise<void>(resolve => { releaseLast = resolve })
  let sequence = 0
  const invoke = vi.fn(async (operation: keyof AiMethods, [id]: unknown[]): Promise<unknown> => {
    const eventSequence = ++sequence
    if (eventSequence === 1) await firstPending
    if (eventSequence === 3) await lastPending
    return { ok: true, value: { id, conversationId: '1', modelId: 'local',
      state: operation === 'stopAnalysis' ? 'stopped' : 'queued', analyzedMessages: 1, totalMessages: 7,
      skippedMessages: 0, usage: {}, valid: true, eventSequence } }
  })
  const client = createAiClient({ invoke, onEvent: () => () => {} })

  const first = client[method]('24')
  const firstDuplicate = client[method]('24')
  const opposite = client[otherMethod]('24')
  const last = client[method]('24')
  const independent = client[otherMethod]('23')

  releaseFirst()
  await first
  const lastDuplicate = client[method]('24')
  releaseLast()

  expect(invoke.mock.calls).toEqual([[method, ['24']], [otherMethod, ['24']], [method, ['24']], [otherMethod, ['23']]])
  const commandState = method === 'stopAnalysis' ? 'stopped' : 'queued'
  expect(await Promise.all([firstDuplicate, opposite, last, independent, lastDuplicate])).toMatchObject([
    { id: '24', state: commandState, eventSequence: 1 },
    { id: '24', state: otherMethod === 'stopAnalysis' ? 'stopped' : 'queued', eventSequence: 2 },
    { id: '24', state: commandState, eventSequence: 3 },
    { id: '23', eventSequence: 4 },
    { id: '24', state: commandState, eventSequence: 3 },
  ])
})
