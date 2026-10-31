import { expect, test } from 'vitest'
import { createAiRouter } from '../../electron/main/ai-router'

test('confirmation credentials and thread mutations stay in their originating window', async () => {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://localhost:9900/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  const task = { id: '1', conversationId: '1', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  let mutations = 0
  const router = createAiRouter({ prepareAnalysis: async () => ({ token: 'token-a', conversationId: '1', title: '示例', selfName: '我', totalMessages: 1, analyzableMessages: 1, snapshotMaxId: '1', expiresAt: 2000, model }), confirmAnalysis: async () => { mutations++; return task }, openThread: async () => ({ id: '1', conversationId: '1', title: '新对话', createdAtMs: 1, updatedAtMs: 1, turns: [] }), sendTurn: async () => { mutations++; return undefined } } as any)
  await router.invoke(1, 'prepareAnalysis', [{ conversationId: '1', modelId: 'm' }])
  await expect(router.invoke(2, 'confirmAnalysis', [{ token: 'token-a', requestId: 'same' }])).rejects.toThrow()
  await router.invoke(1, 'confirmAnalysis', [{ token: 'token-a', requestId: 'same' }])
  expect(mutations).toBe(1)
  await router.invoke(1, 'openThread', ['1'])
  await expect(router.invoke(2, 'sendTurn', [{ threadId: '1', requestId: 'x', prompt: '问题', referenceIds: [], modelId: 'm' }])).rejects.toThrow()
  const received: unknown[] = []
  router.subscribe(2, event => received.push(event))
  router.publish({ kind: 'analysis', snapshot: task } as any)
  expect(received).toEqual([])
})
