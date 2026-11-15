import { expect, test } from 'vitest'
import { createAiService, type RuntimeInput, type RuntimeRunner } from '../../electron/main/ai-service'
import type { AnalysisTask } from '../../src/shared/ai-contract'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { defaultPrompts } from '../../src/shared/system-prompts'

function fixture(run?: RuntimeRunner['run']) {
  const model = { id: 'm', label: '本地测试', model: 'm', baseUrl: 'http://localhost', contextWindow: 16000, maxTokens: 1000, version: 1, enabled: true, hasCredential: true }
  const task: AnalysisTask = { id: '1', scope: { kind: 'all' }, conversationId: '9', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
  const message = { id: '13800138000', revision: 'revision-13800138000', sentAtMs: 1000, senderName: '示例甲', isSelf: true, text: '联系 13800138000', replyToMessageId: null }
  const snapshot = { taskId: '1', scope: { kind: 'all' }, timezone: 'Asia/Shanghai', createdAtMs: 1000, sourceStartTimeMs: 1000, sourceEndTimeMs: 1000, sources: [{ messageId: message.id, revision: message.revision }] }
  const saved: any[] = [], usage: any[] = [], requests: RuntimeInput[] = []
  let checkpoint: string | null = null
  let completed = 0
  const storage = async (method: string, args: any[]) => {
    if (method === 'confirmAnalysis' || method === 'getAnalysis') return { ...task }
    if (method === 'modelSecret') return { model, encryptedKey: 'encrypted' }
    if (method === 'analysisContext') return { task, model, promptVersion: 'conversation-insights-v1', snapshot, messages: [], batches: [], checkpoint, systemPrompts: { ...defaultPrompts, insightReading: '自定义阅读' } }
    if (method === 'readInsightSources') { expect(args[0]).toEqual({ taskId: '1', messageIds: [message.id] }); return [message] }
    if (method === 'saveAnalysis') { Object.assign(task, args[1]); return { ...task } }
    if (method === 'recordUsage') { usage.push(args[0]); return { ...task } }
    if (method === 'saveInsightCheckpoint') {
      if (task.state === 'stopped') return { ...task }
      checkpoint = args[1]; saved.push(JSON.parse(checkpoint!)); task.analyzedMessages = args[2].length; return { ...task }
    }
    if (method === 'completeAnalysis') { completed++; task.state = 'completed'; task.report = args[1]; return { ...task } }
    throw new Error(method)
  }
  const service = createAiService({ storage, processing: async () => ({ settings: defaultProcessing, members: [{ id: '2', displayName: '示例甲' }] }),
    secrets: { encrypt: x => x, decrypt: () => 'credential' }, runtime: { run: async (input, options) => {
      requests.push(input)
      if (run) return run(input, options)
      const payload = JSON.parse(input.prompt)
      return { text: JSON.stringify(payload.stage === 'reading' ? { observations: [], openThreads: [], candidates: [] }
        : { aboutYou: [], relationship: [], citations: [], judgments: [], limitations: ['材料有限。'] }), usage: { inputTokens: 200, outputTokens: 30 }, checkpoint: '' }
    } } })
  return { service, task, requests, saved, usage, message, completed: () => completed }
}

test('new insight tasks use frozen sources, protected text and saved prompts through completion', async () => {
  const f = fixture()
  await f.service.confirmAnalysis({ token: 't', requestId: 'r' })
  await f.service.idle()
  expect(f.task.state).toBe('completed')
  expect(f.task.report).toMatchObject({ format: 'conversation-insights-v1' })
  expect(f.requests.map(x => JSON.parse(x.prompt).stage)).toEqual(['reading', 'writing'])
  const sent = JSON.parse(f.requests[0].prompt).messages[0]
  expect(sent.id).toBe(f.message.id)
  expect(sent.revision).toBe(f.message.revision)
  expect(sent.text).not.toContain('13800138000')
  expect(f.requests[0].systemPrompt).toContain('自定义阅读')
  expect(f.requests[0].apiKey).toBe('credential')
  expect(f.saved.at(-1).coveredMessageIds).toEqual([f.message.id])
  expect(f.usage.filter(x => x.usage.incomplete)).toHaveLength(2)
  expect(f.completed()).toBe(1)
})

test('pausing an insight persists its cancelled attempt before locking the task as stopped', async () => {
  const f = fixture(async (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true })
  }))
  await f.service.confirmAnalysis({ token: 't', requestId: 'r' })
  await expect.poll(() => f.requests.length).toBe(1)
  await f.service.stopAnalysis('1')
  await f.service.idle()
  expect(f.task.state).toBe('stopped')
  expect(f.saved.at(-1).attempts.at(-1).status).toBe('failed')
  expect(f.saved.at(-1).elapsedMs).toBeGreaterThanOrEqual(f.saved[0].elapsedMs)
  expect(f.completed()).toBe(0)
})
