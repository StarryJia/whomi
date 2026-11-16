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

test('洞察改名和原文引用只从持有对应报告的窗口调用', async () => {
  const task = { id: '1', conversationId: '1', modelId: 'm', state: 'completed', analyzedMessages: 1, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  const router = createAiRouter({
    getAnalysis: async () => task,
    renameAnalysis: async (input: { title: string }) => ({ ...task, title: input.title }),
    readInsightCitation: async () => ({ status: 'unavailable' }),
  } as any)
  await router.invoke(1, 'getAnalysis', ['1'])
  for (const [method, input] of [
    ['renameAnalysis', { taskId: '1', title: '那次合作' }],
    ['readInsightCitation', { taskId: '1', citationId: 'time', fragmentIndex: 0 }],
  ] as const) {
    await expect(router.invoke(2, method, [input])).rejects.toHaveProperty('code', 'INVALID_OWNER')
  }
  await expect(router.invoke(1, 'renameAnalysis', [{ taskId: '1', title: '那次合作' }])).resolves.toMatchObject({ title: '那次合作' })
  await expect(router.invoke(1, 'readInsightCitation', [{ taskId: '1', citationId: 'time', fragmentIndex: 0 }])).resolves.toEqual({ status: 'unavailable' })
})

test('准备快照只能由原窗口释放，释放后不影响其他窗口的准备', async () => {
  const model = { id: 'm', label: '示例', model: 'm', baseUrl: 'http://localhost:9900/v1', contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  const pending = new Set<string>()
  let next = 0
  const router = createAiRouter({
    prepareAnalysis: async () => {
      const token = `token-${++next}`
      pending.add(token)
      return { token, conversationId: '1', title: '示例', selfName: '我', totalMessages: 1, analyzableMessages: 1, snapshotMaxId: '1', expiresAt: 2000, model }
    },
    discardAnalysisPreparation: async (token: string) => { pending.delete(token) },
  } as any)
  await router.invoke(1, 'prepareAnalysis', [{ conversationId: '1', modelId: 'm' }])
  await router.invoke(2, 'prepareAnalysis', [{ conversationId: '1', modelId: 'm' }])
  await expect(router.invoke(2, 'discardAnalysisPreparation', ['token-1'])).rejects.toHaveProperty('code', 'INVALID_OWNER')
  await expect(router.invoke(1, 'discardAnalysisPreparation', ['token-1'])).resolves.toBeUndefined()
  expect([...pending]).toEqual(['token-2'])
})
