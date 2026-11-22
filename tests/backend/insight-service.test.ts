import { expect, test, vi } from 'vitest'
import { createAiService, type RuntimeInput, type RuntimeRunner } from '../../electron/main/ai-service'
import type { AnalysisTask } from '../../src/shared/ai-contract'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { defaultPrompts } from '../../src/shared/system-prompts'
import type { AppError } from '../../electron/main/app-error-logs'

function fixture(run?: RuntimeRunner['run'], logError?: (entry: AppError) => void,
  beforeStopWrite?: () => void, beforeElapsedWrite?: () => Promise<void>) {
  const model = { id: 'm', label: '本地测试', model: 'm', baseUrl: 'http://localhost', contextWindow: 16000, maxTokens: 1000, version: 1, enabled: true, hasCredential: true }
  const task: AnalysisTask = { id: '1', scope: { kind: 'all' }, conversationId: '9', modelId: 'm', state: 'queued', analyzedMessages: 0, totalMessages: 1, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1, elapsedMs: 0 }
  const message = { id: '13800138000', revision: 'revision-13800138000', sentAtMs: 1000, senderName: '示例甲', isSelf: true, text: '联系 13800138000', replyToMessageId: null }
  const snapshot = { taskId: '1', scope: { kind: 'all' }, timezone: 'Asia/Shanghai', createdAtMs: 1000, sourceStartTimeMs: 1000, sourceEndTimeMs: 1000, sources: [{ messageId: message.id, revision: message.revision }] }
  const saved: any[] = [], usage: any[] = [], requests: RuntimeInput[] = []
  let checkpoint: string | null = null
  let completed = 0
  const storage = async (method: string, args: any[]) => {
    if (method === 'confirmAnalysis' || method === 'getAnalysis') return { ...task }
    if (method === 'modelSecret') return { model, encryptedKey: 'encrypted' }
    if (method === 'analysisContext') return { task, model, snapshot, checkpoint, systemPrompts: { ...defaultPrompts, insightReading: '自定义阅读' } }
    if (method === 'readInsightSources') { expect(args[0]).toEqual({ taskId: '1', messageIds: [message.id] }); return [message] }
    if (method === 'saveAnalysis') {
      if (args[1].state === 'stopped') beforeStopWrite?.()
      if (typeof args[2] === 'number') task.elapsedMs! += Math.max(0, Date.now() - args[2])
      Object.assign(task, args[1])
      return { ...task }
    }
    if (method === 'recordUsage') { usage.push(args[0]); return { ...task } }
    if (method === 'saveInsightElapsed') {
      await beforeElapsedWrite?.()
      if (task.state === 'running') task.elapsedMs = Math.max(task.elapsedMs!, args[1])
      return { ...task }
    }
    if (method === 'saveInsightCheckpoint') {
      if (task.state === 'stopped') return { ...task }
      checkpoint = args[1]; saved.push(JSON.parse(checkpoint!)); task.analyzedMessages = args[2].length; task.elapsedMs = args[3]; return { ...task }
    }
    if (method === 'completeAnalysis') { completed++; task.state = 'completed'; task.report = args[1]; return { ...task } }
    throw new Error(method)
  }
  const service = createAiService({ storage, logError, processing: async () => ({ settings: defaultProcessing, members: [{ id: '2', displayName: '示例甲' }] }),
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

test('reports the failed insight phase, saved coverage and the budget that stopped writing', async () => {
  const recorded: AppError[] = []
  const f = fixture(async request => {
    const reading = JSON.parse(request.prompt).stage === 'reading'
    return { text: JSON.stringify({ observations: [], openThreads: [], candidates: [] }),
      usage: { inputTokens: 200, outputTokens: reading ? 30 : 33_000 }, checkpoint: '' }
  }, entry => { recorded.push(entry) })
  await f.service.confirmAnalysis({ token: 't', requestId: 'budget' })
  await f.service.idle()
  expect(f.task).toMatchObject({ state: 'failed', analyzedMessages: 1, error: '已达到洞察预算。请缩短日期范围后重新生成。' })
  expect(recorded).toEqual([expect.objectContaining({ area: 'insight', phase: 'writing', taskId: '1', analyzedMessages: 1,
    error: expect.objectContaining({ code: 'INSIGHT_BUDGET_EXHAUSTED' }),
    budget: { name: 'maxOutputTokens', limit: 32_768 } })])
})

test('durably samples elapsed time during a stalled model request and counts it once when stopped', async () => {
  vi.useFakeTimers({ now: 1000, toFake: ['Date', 'setInterval', 'clearInterval'] })
  try {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const f = fixture(async (_input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true })
      markStarted()
    }))
    await f.service.confirmAnalysis({ token: 't', requestId: 'sample' })
    await started

    const reserved = f.saved.at(-1)
    expect(reserved).toMatchObject({ elapsedMs: 0, coveredMessageIds: [], callsReserved: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.task.elapsedMs).toBe(5000)
    expect(await f.service.getAnalysis('1')).toMatchObject({ state: 'running', elapsedMs: 5000, elapsedSampledAtMs: 6000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.task.elapsedMs).toBe(10000)
    expect(f.saved.at(-1)).toBe(reserved)

    await vi.advanceTimersByTimeAsync(500)
    expect(await f.service.stopAnalysis('1')).toMatchObject({ state: 'stopped', elapsedMs: 10500 })
    expect(f.saved.at(-1)).toMatchObject({ elapsedMs: 10500, callsReserved: 1, attempts: [{ status: 'failed' }] })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.task.elapsedMs).toBe(10500)
  } finally {
    vi.useRealTimers()
  }
})

test('a delayed elapsed write cannot overtake a model checkpoint or keep writing after completion', async () => {
  vi.useFakeTimers({ now: 1000, toFake: ['Date', 'setInterval', 'clearInterval'] })
  try {
    const reading = Promise.withResolvers<void>()
    const modelStarted = Promise.withResolvers<void>()
    const elapsedWrite = Promise.withResolvers<void>()
    const elapsedStarted = Promise.withResolvers<void>()
    const f = fixture(async request => {
      const stage = JSON.parse(request.prompt).stage
      if (stage === 'reading') {
        modelStarted.resolve()
        await reading.promise
      }
      return {
        text: JSON.stringify(stage === 'reading' ? { observations: [], openThreads: [], candidates: [] }
          : { aboutYou: [], relationship: [], citations: [], judgments: [], limitations: ['材料有限。'] }),
        usage: { inputTokens: 200, outputTokens: 30 }, checkpoint: '',
      }
    }, undefined, undefined, () => {
      elapsedStarted.resolve()
      return elapsedWrite.promise
    })
    await f.service.confirmAnalysis({ token: 't', requestId: 'delayed-sample' })
    await modelStarted.promise
    const reserved = f.saved.at(-1)
    await vi.advanceTimersByTimeAsync(5000)
    await elapsedStarted.promise
    await vi.advanceTimersByTimeAsync(1000)
    reading.resolve()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.saved.at(-1)).toBe(reserved)
    expect(f.task.state).toBe('running')

    elapsedWrite.resolve()
    await f.service.idle()
    expect(f.task).toMatchObject({ state: 'completed', elapsedMs: 11000, analyzedMessages: 1 })
    expect(f.saved.at(-1)).toMatchObject({ elapsedMs: 11000, callsReserved: 2 })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('pausing an insight persists its cancelled attempt before locking the task as stopped', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const f = fixture(async (_input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true })
    }), undefined, () => clock.mockReturnValue(4500))
    await f.service.confirmAnalysis({ token: 't', requestId: 'r' })
    await expect.poll(() => f.requests.length).toBe(1)
    expect(await f.service.getAnalysis('1')).toMatchObject({ state: 'running', elapsedMs: 0, elapsedSampledAtMs: 1000 })
    clock.mockReturnValue(4000)
    const stopped = await f.service.stopAnalysis('1')
    clock.mockReturnValue(7000)
    expect(stopped).not.toHaveProperty('elapsedSampledAtMs')
    expect(await f.service.getAnalysis('1')).toMatchObject({ state: 'stopped', elapsedMs: 3500 })
    expect(f.saved.at(-1).attempts.at(-1).status).toBe('failed')
    expect(f.saved.at(-1).elapsedMs).toBe(3000)
    expect(f.completed()).toBe(0)
  } finally {
    clock.mockRestore()
  }
})
