import { describe, expect, it, vi } from 'vitest'
import type { AiApi, AiEvent, AiModel, AiTurn, AnalysisTask } from '../shared/ai-contract'
import { createConversationAiClient } from './conversation-ai-client'
import { defaultProcessing, type SettingsApi } from '../shared/settings-contract'

const model: AiModel = { id: 'm', label: '模型', model: 'example', baseUrl: 'https://example.test/v1', contextWindow: 8192, maxTokens: 1024, version: 1, enabled: true, hasCredential: true }
const turn = (state: AiTurn['state'] = 'completed', eventSequence = 1): AiTurn => ({ id: 'turn', threadId: 'thread', requestId: 'request', prompt: '提问', referenceIds: ['1'], modelId: 'm', text: state === 'completed' ? '回答' : '片段', state, attempt: 1, usage: {}, eventSequence })
function api() {
  const listeners = new Set<(event: AiEvent) => void>()
  const methods = { listModels: vi.fn(async () => [model, { ...model, id: 'disabled', enabled: false }]), listSkills: vi.fn(async () => []),
    openThread: vi.fn(async () => ({ id: 'thread', conversationId: 'c', turns: [] as AiTurn[] })),
    getThread: vi.fn(async () => ({ id: 'thread', conversationId: 'c', turns: [turn()] })), sendTurn: vi.fn(async () => turn()), stopTurn: vi.fn(async () => turn('stopped', 3)),
    onEvent: (listener: (event: AiEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    prepareAnalysis: vi.fn(async () => ({ token: 'prepared', conversationId: 'c', title: '会话', selfName: '我', totalMessages: 8, analyzableMessages: 7, snapshotMaxId: '8', expiresAt: Date.now() + 10000, model })),
    confirmAnalysis: vi.fn(async (): Promise<AnalysisTask> => ({ id: 'task', conversationId: 'c', modelId: 'm', state: 'completed', analyzedMessages: 7, totalMessages: 7, skippedMessages: 1, usage: {}, valid: true, eventSequence: 1 })),
    getAnalysis: vi.fn(), stopAnalysis: vi.fn(), getReport: vi.fn(),
  }
  return { methods, client: methods as unknown as AiApi, emit: (event: AiEvent) => listeners.forEach(listener => listener(event)), listeners }
}
describe('正式会话 AI 适配器', () => {
  it('成功保存选模后更新共享偏好，分别记忆两个功能且失败不覆盖', async () => {
    const { client } = api()
    const selectModel = vi.fn<SettingsApi['selectModel']>(async () => {})
    const settings = { get: async () => ({ providers: [], models: [], processing: defaultProcessing, selectedModels: { analysis: 'analysis-before', conversation: 'conversation-before' }, debug: false }), selectModel } as unknown as SettingsApi
    const adapter = await createConversationAiClient(client, settings)
    const sharedSelection = adapter.selectedModels!
    await adapter.selectModel!('conversation', 'conversation-next')
    expect(sharedSelection).toEqual({ analysis: 'analysis-before', conversation: 'conversation-next' })
    selectModel.mockRejectedValueOnce(new Error('保存失败，请重试。'))
    await expect(adapter.selectModel!('analysis', 'analysis-rejected')).rejects.toThrow('保存失败')
    expect(sharedSelection.analysis).toBe('analysis-before')
    await adapter.selectModel!('analysis', 'analysis-next')
    await adapter.selectModel!('conversation', null)
    expect(sharedSelection).toEqual({ analysis: 'analysis-next' })
  })
  it('恢复快照前先到的新轮次事件，不改变后台历史顺序', async () => {
    const { methods, client, emit } = api()
    let complete: (value: Awaited<ReturnType<AiApi['getThread']>>) => void = () => {}
    methods.getThread.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const adapter = await createConversationAiClient(client), controller = new AbortController(), change = vi.fn()
    const pending = adapter.watchThread!('c', change, controller.signal)
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    const recent = { ...turn('running', 2), id: 'new-turn' }
    emit({ kind: 'turn', snapshot: recent })
    complete({ id: 'thread', conversationId: 'c', turns: [{ ...turn(), id: 'old-turn' }, recent] })
    await vi.waitFor(() => expect(change.mock.lastCall?.[0].map((value: AiTurn) => value.id)).toEqual(['old-turn', 'new-turn']))
    controller.abort('detach')
    await pending
  })
  it('仅把引用编号发送给后端，不信任页面正文或历史，并处理订阅前已完成', async () => {
    const { methods, client, listeners } = api()
    const adapter = await createConversationAiClient(client)
    expect(adapter.models).toEqual([{ id: 'm', label: '模型' }])
    const request = { conversationId: 'c', modelId: 'm', prompt: '提问', references: [{ id: '1', messages: [{ id: '1', text: '页面正文' }] }], history: [{ role: 'assistant', text: '伪造历史' }] }
    const result = await adapter.respond(request as never, { signal: new AbortController().signal, onText: vi.fn() })
    expect(result.text).toBe('回答')
    expect(methods.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', prompt: '提问', referenceIds: ['1'], modelId: 'm' }))
    const sent = methods.sendTurn.mock.calls[0] as unknown[]
    expect(sent[0]).not.toHaveProperty('references')
    expect(sent[0]).not.toHaveProperty('history')
    expect(listeners.size).toBe(0)
  })
  it('等待中的响应按事件序号去重，显式停止通知后端', async () => {
    const { methods, client, emit } = api()
    methods.sendTurn.mockImplementation(async () => turn('running', 2))
    methods.getThread.mockImplementation(async () => ({ id: 'thread', conversationId: 'c', turns: [turn('running', 2)] }))
    const adapter = await createConversationAiClient(client)
    const controller = new AbortController(), text = vi.fn()
    const pending = adapter.respond({ conversationId: 'c', modelId: 'm', prompt: '提问', references: [] }, { signal: controller.signal, onText: text })
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    emit({ kind: 'turn', snapshot: { ...turn('running', 3), text: '新片段' } })
    emit({ kind: 'turn', snapshot: { ...turn('running', 1), text: '旧片段' } })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(text).toHaveBeenCalledWith('新片段')
    expect(text).not.toHaveBeenCalledWith('旧片段')
    expect(methods.stopTurn).toHaveBeenCalledWith('turn')
  })
  it('离页只解除观察，不停止后台；已取消请求不会提交', async () => {
    const { methods, client } = api()
    methods.sendTurn.mockImplementation(async () => turn('running', 1))
    methods.getThread.mockImplementation(async () => ({ id: 'thread', conversationId: 'c', turns: [turn('running', 1)] }))
    const adapter = await createConversationAiClient(client)
    const controller = new AbortController()
    const pending = adapter.respond({ conversationId: 'c', modelId: 'm', prompt: '提问', references: [] }, { signal: controller.signal, onText: vi.fn() })
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    controller.abort('detach')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(methods.stopTurn).not.toHaveBeenCalled()
    const cancelled = new AbortController(); cancelled.abort()
    await expect(adapter.respond({ conversationId: 'c', modelId: 'm', prompt: 'x', references: [] }, { signal: cancelled.signal, onText: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(methods.sendTurn).toHaveBeenCalledTimes(1)
  })
  it('分析必须携带准备凭据，不接受仅页面提供的消息总数', async () => {
    const { methods, client } = api()
    const adapter = await createConversationAiClient(client)
    const prepared = await adapter.prepareAnalysis!({ conversationId: 'c', modelId: 'm' })
    expect(methods.confirmAnalysis).not.toHaveBeenCalled()
    const options = { signal: new AbortController().signal, onProgress: vi.fn() }
    await expect(adapter.analyze({ conversationId: 'c', modelId: 'm' }, options)).rejects.toThrow('请重新确认分析范围')
    const result = await adapter.analyze({ conversationId: 'c', modelId: 'm', preparationToken: prepared.token }, options)
    expect(methods.confirmAnalysis).toHaveBeenCalledWith(expect.objectContaining({ token: 'prepared' }))
    expect(result).toMatchObject({ taskId: 'task' })
    expect(options.onProgress).toHaveBeenCalledWith(expect.objectContaining({ analyzedMessages: 7, totalMessages: 7 }))
  })
})
