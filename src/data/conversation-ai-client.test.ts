import { describe, expect, it, vi } from 'vitest'
import type { RestoredConversationTurn } from '../components/conversation-ai/types'
import type { AiApi, AiEvent, AiModel, AiTurn, AnalysisTask } from '../shared/ai-contract'
import { createConversationAiClient, isConversationNotSubmitted } from './conversation-ai-client'
import { defaultProcessing, type SettingsApi } from '../shared/settings-contract'

const model: AiModel = { id: 'm', label: '模型', model: 'example', baseUrl: 'https://example.test/v1', contextWindow: 8192, maxTokens: 1024, version: 1, enabled: true, hasCredential: true }
const turn = (state: AiTurn['state'] = 'completed', eventSequence = 1): AiTurn => ({ id: 'turn', threadId: 'thread', requestId: 'request', prompt: '提问', referenceIds: ['1'], modelId: 'm', text: state === 'completed' ? '回答' : '片段', state, attempt: 1, usage: {}, eventSequence })
function api() {
  const listeners = new Set<(event: AiEvent) => void>()
  const methods = { listModels: vi.fn(async () => [model, { ...model, id: 'disabled', enabled: false }]), listSkills: vi.fn(async () => []),
    openThread: vi.fn<AiApi['openThread']>(async () => ({ id: 'thread', conversationId: 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [] as AiTurn[] })),
    getThread: vi.fn<AiApi['getThread']>(async () => ({ id: 'thread', conversationId: 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [turn()] })), sendTurn: vi.fn<AiApi['sendTurn']>(async () => turn()), stopTurn: vi.fn(async () => turn('stopped', 3)),
    retryTurn: vi.fn<AiApi['retryTurn']>(),
    onEvent: (listener: (event: AiEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    prepareAnalysis: vi.fn(async () => ({ token: 'prepared', conversationId: 'c', title: '会话', selfName: '我', totalMessages: 8, analyzableMessages: 7, snapshotMaxId: '8', expiresAt: Date.now() + 10000, model })),
    confirmAnalysis: vi.fn(async (): Promise<AnalysisTask> => ({ id: 'task', conversationId: 'c', modelId: 'm', state: 'completed', analyzedMessages: 7, totalMessages: 7, skippedMessages: 1, usage: {}, valid: true, eventSequence: 1 })),
    getAnalysis: vi.fn<AiApi['getAnalysis']>(), stopAnalysis: vi.fn<AiApi['stopAnalysis']>(), getReport: vi.fn(),
    continueAnalysis: vi.fn<AiApi['continueAnalysis']>(), listAnalyses: vi.fn<AiApi['listAnalyses']>(),
  }
  return { methods, client: methods as unknown as AiApi, emit: (event: AiEvent) => listeners.forEach(listener => listener(event)), listeners }
}
describe('正式会话 AI 适配器', () => {
  it('显式选择的对话控制恢复与发送，拒绝另一会话的线程', async () => {
    const { client, methods } = api()
    methods.getThread.mockImplementation(async (id: string) => ({ id, conversationId: id === 'foreign' ? 'other' : 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [{ ...turn(), threadId: id, text: `回答 ${id}` }] }))
    methods.sendTurn.mockImplementation(async input => ({ ...turn(), threadId: input.threadId, text: `回答 ${input.threadId}` }))
    const adapter = await createConversationAiClient(client)
    expect((await adapter.restoreThread!('c', 'second'))[0].text).toBe('回答 second')
    const response = await adapter.respond({ conversationId: 'c', threadId: 'second', modelId: 'm', prompt: '问题', references: [] }, { signal: new AbortController().signal, onText: vi.fn() })
    expect(response.text).toBe('回答 second')
    expect(methods.openThread).not.toHaveBeenCalled()
    await expect(adapter.restoreThread!('c', 'foreign')).rejects.toThrow()
    await expect(adapter.respond({ conversationId: 'c', threadId: 'foreign', modelId: 'm', prompt: '问题', references: [] }, { signal: new AbortController().signal, onText: vi.fn() })).rejects.toThrow()
    expect(methods.sendTurn).toHaveBeenCalledTimes(1)
  })
  it('所选线程的事件更新不会显示另一线程的内容，离开时不停止回答', async () => {
    const { client, methods, emit } = api()
    methods.getThread.mockImplementation(async (id: string) => ({ id, conversationId: 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [{ ...turn('running'), threadId: id }] }))
    const adapter = await createConversationAiClient(client), controller = new AbortController(), change = vi.fn()
    const pending = adapter.watchThread!('c', change, controller.signal, 'second')
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1))
    emit({ kind: 'turn', snapshot: { ...turn('completed', 2), threadId: 'first', text: '其他线程' } })
    expect(change).toHaveBeenCalledTimes(1)
    emit({ kind: 'turn', snapshot: { ...turn('completed', 2), threadId: 'second', text: '当前线程' } })
    expect(change.mock.lastCall?.[0][0].text).toBe('当前线程')
    controller.abort('detach'); await pending
    expect(methods.stopTurn).not.toHaveBeenCalled()
  })
  it('同名模型保留服务商归属，已停用服务商不进入可选菜单', async () => {
    const { client, methods } = api()
    methods.listModels.mockResolvedValue([model, { ...model, id: 'second' }, { ...model, id: 'off' }])
    const settings = { get: async () => ({ providers: [
      { id: 'a', name: '示例服务 A', enabled: true }, { id: 'b', name: '示例服务 B', enabled: true }, { id: 'c', name: '停用服务', enabled: false }],
      models: [{ id: 'm', providerId: 'a', group: '系列 A' }, { id: 'second', providerId: 'b' }, { id: 'off', providerId: 'c' }],
      processing: defaultProcessing, selectedModels: {}, debug: false }) } as unknown as SettingsApi
    const adapter = await createConversationAiClient(client, settings)
    expect(adapter.models).toEqual([
      { id: 'm', label: '模型', model: 'example', version: 1, providerId: 'a', providerName: '示例服务 A', group: '系列 A' },
      { id: 'second', label: '模型', model: 'example', version: 1, providerId: 'b', providerName: '示例服务 B' },
    ])
  })
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
    complete({ id: 'thread', conversationId: 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [{ ...turn(), id: 'old-turn' }, recent] })
    await vi.waitFor(() => expect(change.mock.lastCall?.[0].map((value: AiTurn) => value.id)).toEqual(['old-turn', 'new-turn']))
    controller.abort('detach')
    await pending
  })
  it('仅把引用编号发送给后端，不信任页面正文或历史，并处理订阅前已完成', async () => {
    const { methods, client, listeners } = api()
    const adapter = await createConversationAiClient(client)
    expect(adapter.models).toEqual([{ id: 'm', label: '模型', model: 'example', version: 1 }])
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
    methods.getThread.mockImplementation(async () => ({ id: 'thread', conversationId: 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [turn('running', 2)] }))
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
  it('回执、补读和事件均在正文前交付原序号快照，过滤旧快照', async () => {
    const { methods, client, emit } = api()
    const initial = { ...turn('running', 1), text: '回执片段' }
    const polled = { ...turn('running', 4), text: '补读片段' }
    const finished = turn('completed', 8)
    methods.sendTurn.mockResolvedValue(initial)
    methods.getThread.mockResolvedValue({ ...await methods.openThread('c'), turns: [polled] })
    const adapter = await createConversationAiClient(client)
    const updates: unknown[] = []
    const options = {
      signal: new AbortController().signal,
      onSnapshot: (snapshot: RestoredConversationTurn) => { updates.push(snapshot) },
      onText: (text: string) => { updates.push(text) },
    }
    const pending = adapter.respond({ conversationId: 'c', requestId: 'request', modelId: 'm', prompt: '提问', references: [] }, options)
    await vi.waitFor(() => expect(updates).toContain('补读片段'))
    emit({ kind: 'turn', snapshot: { ...turn('running', 3), text: '旧片段' } })
    emit({ kind: 'turn', snapshot: polled })
    emit({ kind: 'turn', snapshot: finished })
    await pending
    expect(updates).toEqual([initial, '回执片段', polled, '补读片段', finished, '回答'])
  })
  it('收到排队快照时就通知受理，后续首段正文和完成事件不重复通知', async () => {
    const { methods, client, emit } = api()
    const queued = { ...turn('queued'), text: '' }
    methods.sendTurn.mockResolvedValue(queued)
    methods.getThread.mockResolvedValue({ ...await methods.openThread('c'), turns: [queued] })
    const adapter = await createConversationAiClient(client)
    const updates: string[] = []
    const accepted = vi.fn(() => { updates.push('受理') })
    const options = { signal: new AbortController().signal, onAccepted: accepted, onText: (text: string) => { if (text) updates.push(text) } }
    const pending = adapter.respond({ conversationId: 'c', requestId: 'request', modelId: 'm', prompt: '提问', references: [] }, options)
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    const beforeFirstText = [...updates]
    emit({ kind: 'turn', snapshot: { ...turn('running', 2), text: '首段' } })
    emit({ kind: 'turn', snapshot: turn('completed', 3) })
    await pending
    expect(beforeFirstText).toEqual(['受理'])
    expect(updates).toEqual(['受理', '首段', '回答'])
    expect(accepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'turn', requestId: 'request', state: 'queued', eventSequence: 1 }))
  })
  it.each(['completed', 'failed', 'stopped', 'interrupted'] as const)('重复编号收到 %s 快照时仍通知受理', async state => {
    const { methods, client } = api()
    const saved = { ...turn(state, 4), usage: { outputTokens: 18 } }
    methods.sendTurn.mockResolvedValue(saved)
    const adapter = await createConversationAiClient(client)
    const updates: string[] = []
    const accepted = vi.fn(() => { updates.push('受理') })
    const options = { signal: new AbortController().signal, onAccepted: accepted, onText: () => { updates.push('正文') } }
    const pending = adapter.respond({ conversationId: 'c', requestId: 'request', modelId: 'm', prompt: '提问', references: [] }, options)
    if (state === 'completed') {
      await expect(pending).resolves.toMatchObject({ text: '回答', usage: { outputTokens: 18 }, turn: { id: 'turn', eventSequence: 4 } })
    } else {
      await expect(pending).rejects.toMatchObject({ turn: { id: 'turn', state, eventSequence: 4 } })
    }
    expect(updates).toEqual(['受理', '正文'])
    expect(accepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'turn', requestId: 'request', state, eventSequence: 4 }))
  })
  it('发送回执丢失时按请求编号找回已有轮次，只提交一次', async () => {
    const { methods, client } = api()
    methods.sendTurn.mockRejectedValue(new Error('未收到发送回执'))
    methods.getThread.mockResolvedValue({ ...await methods.openThread('c'), turns: [
      { ...turn(), requestId: 'earlier', id: 'earlier-turn' },
      { ...turn('completed', 5), requestId: 'lost-reply', id: 'saved-turn', text: '已保存的回答' },
    ] })
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', requestId: 'lost-reply', modelId: 'm', prompt: '提问', referenceIds: ['1', '1'], references: [] }, options))
      .resolves.toMatchObject({ text: '已保存的回答', turn: { id: 'saved-turn', requestId: 'lost-reply', eventSequence: 5 } })
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'saved-turn', requestId: 'lost-reply' }))
    expect(methods.sendTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: 'lost-reply', referenceIds: ['1'] }))
    expect(methods.getThread).toHaveBeenCalledExactlyOnceWith('thread')
  })
  it.each([
    ['模型', { modelId: 'missing-model' }, Object.assign(new Error('请选择可用模型。'), { code: 'INVALID_MODEL' })],
    ['提问', { prompt: '另一条提问' }, new Error('未收到发送回执')],
    ['引用顺序', { referenceIds: ['2', '1'] }, new Error('未收到发送回执')],
    ['引用数量', { referenceIds: ['1'] }, new Error('未收到发送回执')],
    ['技能', { skillId: 'other-skill' }, new Error('未收到发送回执')],
    ['思考强度', { thinkingLevel: 'medium' as const }, new Error('未收到发送回执')],
  ] as const)('同编号的已保存轮次与本次%s不同时保留发送错误', async (_field, changed, rejected) => {
    const { methods, client } = api()
    const saved = { ...turn(), referenceIds: ['1', '2'], skillId: 'review', thinkingLevel: 'high' as const }
    methods.sendTurn.mockRejectedValue(rejected)
    methods.getThread.mockResolvedValue({ ...await methods.openThread('c'), turns: [saved] })
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', requestId: 'request', prompt: '提问', modelId: 'm',
      references: [], referenceIds: ['1', '2'], skillId: 'review', thinkingLevel: 'high', ...changed }, options)).rejects.toBe(rejected)
    expect(onAccepted).not.toHaveBeenCalled()
  })
  it('核对后找不到本次请求时保留原发送错误，不通知受理', async () => {
    const { methods, client } = api()
    const rejected = Object.assign(new Error('请选择可用模型。'), { code: 'INVALID_MODEL' })
    methods.sendTurn.mockRejectedValue(rejected)
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', requestId: 'missing', modelId: 'm', prompt: '提问', references: [] }, options)).rejects.toBe(rejected)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.getThread).toHaveBeenCalledExactlyOnceWith('thread')
  })
  it('发送和核对都失败时保留待确认编号，使用同一个请求对象重试不换号', async () => {
    const { methods, client } = api()
    methods.sendTurn.mockRejectedValueOnce(new Error('未收到发送回执'))
      .mockImplementation(async input => ({ ...turn(), requestId: input.requestId }))
    methods.getThread.mockRejectedValueOnce(new Error('读取失败'))
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    const request = { conversationId: 'c', modelId: 'm', prompt: '提问', references: [] }
    const pending = adapter.respond(request, options)
    await expect(pending).rejects.toMatchObject({ code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: expect.any(String) })
    expect(onAccepted).not.toHaveBeenCalled()
    const [{ requestId }] = methods.sendTurn.mock.calls[0]
    await expect(pending).rejects.toMatchObject({ requestId })
    await expect(adapter.respond(request, options)).resolves.toMatchObject({ turn: { requestId } })
    expect(methods.sendTurn.mock.calls.map(([input]) => input.requestId)).toEqual([requestId, requestId])
  })
  it.each([
    ['显式停止', undefined, { code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: 'request', stopRequested: true }],
    ['离页', 'detach', { name: 'AbortError' }],
  ] as const)('发送回执丢失且回查也失败时区分%s', async (_action, reason, expected) => {
    const { methods, client } = api()
    const controller = new AbortController()
    let rejectRead!: (error: Error) => void
    methods.sendTurn.mockRejectedValue(new Error('未收到发送回执'))
    methods.getThread.mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject }))
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: controller.signal, onAccepted, onText: vi.fn() }
    const pending = adapter.respond({ conversationId: 'c', requestId: 'request', modelId: 'm', prompt: '提问', references: [] }, options)
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    controller.abort(reason)
    rejectRead(new Error('读取失败'))
    await expect(pending).rejects.toMatchObject(expected)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.stopTurn).not.toHaveBeenCalled()
  })
  it.each([
    ['等待回查', undefined, { code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: 'request', stopRequested: false }],
    ['显式停止', 'stop', { code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: 'request', stopRequested: true }],
    ['离页', 'detach', { name: 'AbortError' }],
  ] as const)('回执丢失且保存快照只省略思考强度时处理%s', async (_action, reason, expected) => {
    const { methods, client } = api()
    const controller = new AbortController()
    const savedThread = { ...await methods.openThread('c'), turns: [turn()] }
    let returnThread!: (thread: typeof savedThread) => void
    methods.sendTurn.mockRejectedValue(new Error('未收到发送回执'))
    methods.getThread.mockImplementation(() => new Promise(resolve => { returnThread = resolve }))
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: controller.signal, onAccepted, onText: vi.fn() }
    const pending = adapter.respond({ conversationId: 'c', requestId: 'request', modelId: 'm', prompt: '提问',
      thinkingLevel: 'high', referenceIds: ['1'], references: [] }, options)
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    if (reason) controller.abort(reason)
    returnThread(savedThread)
    await expect(pending).rejects.toMatchObject(expected)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.stopTurn).not.toHaveBeenCalled()
    expect(methods.sendTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: 'request', thinkingLevel: 'high' }))
  })
  it('回查快照同时省略思考强度且引用不同仍保留原发送错误', async () => {
    const { methods, client } = api()
    const rejected = new Error('未收到发送回执')
    methods.sendTurn.mockRejectedValue(rejected)
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', requestId: 'request', modelId: 'm', prompt: '提问',
      thinkingLevel: 'high', referenceIds: ['2'], references: [] }, options)).rejects.toBe(rejected)
    expect(onAccepted).not.toHaveBeenCalled()
  })
  it('重试只提交已有轮次编号，并返回保存的提问、引用和模型身份', async () => {
    const { methods, client } = api()
    const prior = { ...turn('failed', 2), modelIdentity: { id: 'm', version: 1, label: '原模型', model: 'example' } }
    const retried = { ...prior, ...turn('completed', 6), attempt: 2 }
    methods.getThread.mockResolvedValue({ ...await methods.openThread('c'), turns: [prior] })
    methods.retryTurn.mockResolvedValue(retried)
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', turnId: 'turn', modelId: 'different', prompt: '新草稿', referenceIds: ['2'], references: [] }, options))
      .resolves.toMatchObject({ turn: { id: 'turn', prompt: '提问', referenceIds: ['1'], modelIdentity: { label: '原模型' } } })
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'turn', modelId: 'm', requestId: 'request' }))
    expect(methods.retryTurn).toHaveBeenCalledExactlyOnceWith('turn')
    expect(methods.sendTurn).not.toHaveBeenCalled()
  })
  it('重试回执丢失后从同一轮次恢复已完成的新尝试', async () => {
    const { methods, client } = api()
    const thread = await methods.openThread('c')
    const prior = turn('failed', 2)
    const completed = { ...turn('completed', 6), attempt: 2 }
    methods.getThread.mockResolvedValueOnce({ ...thread, turns: [prior] }).mockResolvedValueOnce({ ...thread, turns: [completed] })
    methods.retryTurn.mockRejectedValue(new Error('未收到重试回执'))
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', threadId: 'thread', turnId: 'turn', modelId: 'm', prompt: '提问', references: [] }, options))
      .resolves.toMatchObject({ text: '回答', turn: { id: 'turn', requestId: 'request', state: 'completed', attempt: 2, eventSequence: 6 } })
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(completed)
    expect(methods.retryTurn).toHaveBeenCalledExactlyOnceWith('turn')
    expect(methods.sendTurn).not.toHaveBeenCalled()
  })
  it.each([2, 3])('回查重试仍为旧尝试且事件序号为 %i 时保留待确认', async eventSequence => {
    const { methods, client } = api()
    const thread = await methods.openThread('c')
    methods.getThread.mockResolvedValueOnce({ ...thread, turns: [turn('failed', 2)] })
      .mockResolvedValueOnce({ ...thread, turns: [{ ...turn('failed', eventSequence), usage: { outputTokens: 8 } }] })
    methods.retryTurn.mockRejectedValue(Object.assign(new Error('未能读取重试回执。'), { code: 'INVALID_RESPONSE' }))
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', threadId: 'thread', requestId: 'outdated-ui-id', turnId: 'turn', modelId: 'm', prompt: '提问', references: [] }, options))
      .rejects.toMatchObject({ code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: 'request', stopRequested: false, retryBaseline: { attempt: 1, eventSequence: 2 } })
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.retryTurn).toHaveBeenCalledExactlyOnceWith('turn')
  })
  it('重试被后端明确拒绝且回查仍为旧尝试时保留原错误', async () => {
    const { methods, client } = api()
    const thread = { ...await methods.openThread('c'), turns: [turn('failed', 2)] }
    methods.getThread.mockResolvedValue(thread)
    const rejected = Object.assign(new Error('模型配置已更新，请重新提问。'), { code: 'MODEL_CHANGED' })
    methods.retryTurn.mockRejectedValue(rejected)
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    await expect(adapter.respond({ conversationId: 'c', threadId: 'thread', turnId: 'turn', modelId: 'm', prompt: '提问', references: [] }, options)).rejects.toBe(rejected)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.getThread.mock.calls).toEqual([['thread'], ['thread']])
  })
  it.each([
    ['MODEL_CHANGED', false],
    ['INVALID_OWNER', true],
    ['CONVERSATION_DELETING', true],
  ] as const)('重试返回 %s 且回查失败时按错误发生阶段判断是否待确认', async (code, uncertain) => {
    const { methods, client } = api()
    const thread = { ...await methods.openThread('c'), turns: [turn('failed', 2)] }
    methods.getThread.mockResolvedValueOnce(thread).mockRejectedValueOnce(new Error('读取失败'))
    const rejected = Object.assign(new Error('无法重试。'), { code })
    methods.retryTurn.mockRejectedValue(rejected)
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: new AbortController().signal, onAccepted, onText: vi.fn() }
    const pending = adapter.respond({ conversationId: 'c', threadId: 'thread', turnId: 'turn', modelId: 'm', prompt: '提问', references: [] }, options)
    if (uncertain) await expect(pending).rejects.toMatchObject({ code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: 'request' })
    else await expect(pending).rejects.toBe(rejected)
    expect(isConversationNotSubmitted(rejected)).toBe(!uncertain)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.retryTurn).toHaveBeenCalledExactlyOnceWith('turn')
  })
  it.each([
    ['显式停止', undefined, { code: 'CONVERSATION_ACCEPTANCE_PENDING', requestId: 'request', stopRequested: true, retryBaseline: { attempt: 1, eventSequence: 2 } }],
    ['离页', 'detach', { name: 'AbortError' }],
  ] as const)('重试回执和回查均失败时区分%s', async (_action, reason, expected) => {
    const { methods, client } = api()
    const controller = new AbortController()
    const thread = { ...await methods.openThread('c'), turns: [turn('failed', 2)] }
    let rejectRead!: (error: Error) => void
    methods.getThread.mockResolvedValueOnce(thread)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject }))
    methods.retryTurn.mockRejectedValue(new Error('未收到重试回执'))
    const adapter = await createConversationAiClient(client)
    const onAccepted = vi.fn()
    const options = { signal: controller.signal, onAccepted, onText: vi.fn() }
    const pending = adapter.respond({ conversationId: 'c', threadId: 'thread', turnId: 'turn', modelId: 'm', prompt: '提问', references: [] }, options)
    const outcome = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(methods.retryTurn).toHaveBeenCalled())
    controller.abort(reason)
    rejectRead?.(new Error('读取失败'))
    expect(await outcome).toMatchObject(expected)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(methods.stopTurn).not.toHaveBeenCalled()
  })
  it('重试前找不到原轮次时拒绝请求', async () => {
    const { methods, client } = api()
    methods.getThread.mockResolvedValue(await methods.openThread('c'))
    const adapter = await createConversationAiClient(client)
    await expect(adapter.respond({ conversationId: 'c', threadId: 'thread', turnId: 'missing-turn', modelId: 'm', prompt: '提问', references: [] },
      { signal: new AbortController().signal, onText: vi.fn() })).rejects.toThrow()
    expect(methods.retryTurn).not.toHaveBeenCalled()
  })
  it.each(['detach', 'stop'])('对话读取完成前取消 %s 时标记未提交', async reason => {
    const { methods, client } = api()
    const thread = await methods.openThread('c')
    const controller = new AbortController()
    let returnThread!: (value: typeof thread) => void
    methods.getThread.mockImplementation(() => new Promise(resolve => { returnThread = resolve }))
    const adapter = await createConversationAiClient(client)
    const outcome = adapter.respond({ conversationId: 'c', threadId: 'thread', modelId: 'm', prompt: '提问', references: [] },
      { signal: controller.signal, onText: vi.fn() }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(methods.getThread).toHaveBeenCalled())
    controller.abort(reason)
    returnThread(thread)
    const error = await outcome
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(isConversationNotSubmitted(error)).toBe(true)
    expect(methods.sendTurn).not.toHaveBeenCalled()
    expect(methods.retryTurn).not.toHaveBeenCalled()
  })
  it.each([
    ['MODEL_CHANGED', true],
    ['INVALID_OWNER', false],
  ] as const)('重试提交后离页且收到 %s 时仅标记明确的入库前拒绝', async (code, notSubmitted) => {
    const { methods, client } = api()
    const controller = new AbortController()
    methods.getThread.mockResolvedValue({ ...await methods.openThread('c'), turns: [turn('failed', 2)] })
    let rejectRetry!: (error: Error) => void
    methods.retryTurn.mockImplementation(() => new Promise((_resolve, reject) => { rejectRetry = reject }))
    const adapter = await createConversationAiClient(client)
    const outcome = adapter.respond({ conversationId: 'c', threadId: 'thread', turnId: 'turn', modelId: 'm', prompt: '提问', references: [] },
      { signal: controller.signal, onText: vi.fn() }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(methods.retryTurn).toHaveBeenCalled())
    controller.abort('detach')
    const rejected = Object.assign(new Error('无法重试。'), { code })
    rejectRetry(rejected)
    const error = await outcome
    if (notSubmitted) expect(error).toBe(rejected)
    else expect(error).toMatchObject({ name: 'AbortError' })
    expect(isConversationNotSubmitted(error)).toBe(notSubmitted)
    expect(methods.stopTurn).not.toHaveBeenCalled()
  })
  it('离页只解除观察，不停止后台；已取消请求不会提交', async () => {
    const { methods, client } = api()
    methods.sendTurn.mockImplementation(async () => turn('running', 1))
    methods.getThread.mockImplementation(async () => ({ id: 'thread', conversationId: 'c', title: '示例对话', createdAtMs: 1, updatedAtMs: 1, turns: [turn('running', 1)] }))
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
  it('恢复旧任务后用同一编号继续，在首个进度保留已分析数量，忽略上一次停止回执', async () => {
    const { methods, client, emit } = api()
    const paused: AnalysisTask = { id: 'saved', conversationId: 'c', modelId: 'm', state: 'stopped',
      analyzedMessages: 3, totalMessages: 7, skippedMessages: 1, usage: { outputTokens: 25 }, valid: true, eventSequence: 4 }
    const resumed = { ...paused, state: 'queued' as const, eventSequence: 5 }
    methods.listAnalyses.mockResolvedValue([{ ...paused, id: 'newer', state: 'completed' }, paused])
    methods.continueAnalysis.mockResolvedValue(resumed)
    methods.getAnalysis.mockResolvedValue(paused)
    const adapter = await createConversationAiClient(client), signal = new AbortController().signal
    const restored = vi.fn(), progress = vi.fn()
    await adapter.watchAnalysis!('c', restored, signal, paused.id)
    expect(restored).toHaveBeenCalledWith(paused)
    const pending = adapter.continueAnalysis!(restored.mock.lastCall![0].id, signal, progress)
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1))
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ task: resumed, analyzedMessages: 3, totalMessages: 7 }))
    emit({ kind: 'analysis', snapshot: paused })
    emit({ kind: 'analysis', snapshot: { ...resumed, id: 'unrelated', eventSequence: 9 } })
    expect(progress).toHaveBeenCalledTimes(1)
    const complete = { ...resumed, state: 'completed' as const, analyzedMessages: 7, eventSequence: 8 }
    emit({ kind: 'analysis', snapshot: complete })
    expect(await pending).toMatchObject({ taskId: 'saved', task: complete })
    expect(methods.continueAnalysis).toHaveBeenCalledWith('saved')
    expect(methods.confirmAnalysis).not.toHaveBeenCalled()
    expect(methods.prepareAnalysis).not.toHaveBeenCalled()
  })
  it('首次分析在完成前即交付可暂停的任务编号，暂停的最终回执保留最新检查点', async () => {
    const { methods, client, emit } = api()
    const running: AnalysisTask = { id: 'new', conversationId: 'c', modelId: 'm', state: 'running',
      analyzedMessages: 0, totalMessages: 7, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1 }
    const paused = { ...running, state: 'stopped' as const, analyzedMessages: 3, eventSequence: 3 }
    methods.confirmAnalysis.mockResolvedValue(running)
    methods.getAnalysis.mockResolvedValue(running)
    methods.stopAnalysis.mockImplementation(async () => { emit({ kind: 'analysis', snapshot: paused }); return paused })
    const adapter = await createConversationAiClient(client), onProgress = vi.fn()
    const pending = adapter.analyze({ conversationId: 'c', modelId: 'm', preparationToken: 'prepared' },
      { signal: new AbortController().signal, onProgress })
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalled())
    expect(await adapter.stopAnalysis!(onProgress.mock.lastCall![0].task.id)).toEqual(paused)
    expect(await pending).toMatchObject({ task: paused })
    expect(methods.stopAnalysis).toHaveBeenCalledExactlyOnceWith('new')
  })
  it('续跑提交中离页只解除观察，配置变化的拒绝保留后台错误且不新建分析', async () => {
    const { methods, client } = api()
    let acknowledge!: (value: AnalysisTask) => void
    methods.continueAnalysis.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve }))
    const adapter = await createConversationAiClient(client), controller = new AbortController(), progress = vi.fn()
    const pending = adapter.continueAnalysis!('saved', controller.signal, progress)
    controller.abort('detach')
    acknowledge({ id: 'saved', conversationId: 'c', modelId: 'm', state: 'running', analyzedMessages: 3,
      totalMessages: 7, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3 })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).not.toHaveBeenCalled()
    expect(methods.stopAnalysis).not.toHaveBeenCalled()
    const changed = Object.assign(new Error('消息处理设置已更新，请重新发起分析。'), { code: 'PROCESSING_CHANGED' })
    methods.continueAnalysis.mockRejectedValueOnce(changed)
    await expect(adapter.continueAnalysis!('saved', new AbortController().signal, progress)).rejects.toBe(changed)
    expect(methods.prepareAnalysis).not.toHaveBeenCalled()
    expect(methods.confirmAnalysis).not.toHaveBeenCalled()
  })
  it('续跑已启动时一次进度读取失败会重读快照，不重新提交模型工作', async () => {
    const { methods, client } = api()
    const active: AnalysisTask = { id: 'saved', conversationId: 'c', modelId: 'm', state: 'running',
      analyzedMessages: 3, totalMessages: 7, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3 }
    const complete = { ...active, state: 'completed' as const, analyzedMessages: 7, eventSequence: 5 }
    methods.continueAnalysis.mockResolvedValue(active)
    methods.getAnalysis.mockRejectedValueOnce({ code: 'OPERATION_FAILED' }).mockResolvedValue(complete)
    const adapter = await createConversationAiClient(client)
    const result = await adapter.continueAnalysis!('saved', new AbortController().signal, vi.fn())
    expect(result.task).toEqual(complete)
    expect(methods.continueAnalysis).toHaveBeenCalledTimes(1)
    expect(methods.getAnalysis).toHaveBeenCalledTimes(2)
  })
  it('连续读取失败后保留事件订阅而不无限轮询，已删除任务的确定性错误立即停止观察', async () => {
    const { methods, client, emit, listeners } = api()
    const active: AnalysisTask = { id: 'saved', conversationId: 'c', modelId: 'm', state: 'running',
      analyzedMessages: 3, totalMessages: 7, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3 }
    methods.continueAnalysis.mockResolvedValue(active)
    methods.getAnalysis.mockRejectedValue({ code: 'SERVICE_UNAVAILABLE' })
    const adapter = await createConversationAiClient(client), progress = vi.fn()
    vi.useFakeTimers()
    try {
      const pending = adapter.continueAnalysis!('saved', new AbortController().signal, progress)
      await vi.advanceTimersByTimeAsync(60000)
      expect(methods.getAnalysis).toHaveBeenCalledTimes(4)
      expect(listeners.size).toBe(1)
      emit({ kind: 'analysis', snapshot: { ...active, state: 'completed', analyzedMessages: 7, eventSequence: 5 } })
      expect(await pending).toMatchObject({ task: { state: 'completed' } })
      expect(listeners.size).toBe(0)
      methods.getAnalysis.mockRejectedValue({ code: 'INVALID_TASK' })
      await expect(adapter.continueAnalysis!('saved', new AbortController().signal, progress)).rejects.toMatchObject({ code: 'INVALID_TASK' })
      expect(methods.getAnalysis).toHaveBeenCalledTimes(5)
      expect(listeners.size).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('继续时后台已经运行则改为观察该任务，展示已有或最终的报告', async () => {
    const { methods, client } = api()
    const active: AnalysisTask = { id: 'saved', conversationId: 'c', modelId: 'm', state: 'summarizing',
      analyzedMessages: 7, totalMessages: 7, skippedMessages: 0, usage: {}, valid: true, eventSequence: 5 }
    methods.continueAnalysis.mockRejectedValue({ code: 'INVALID_STATE' })
    methods.getAnalysis.mockResolvedValueOnce(active).mockResolvedValue({ ...active, state: 'completed', eventSequence: 6 })
    const adapter = await createConversationAiClient(client), progress = vi.fn()
    const result = await adapter.continueAnalysis!('saved', new AbortController().signal, progress)
    expect(progress.mock.calls.map(([value]) => value.task.state)).toEqual(['summarizing', 'completed'])
    expect(result.task?.state).toBe('completed')
    expect(methods.continueAnalysis).toHaveBeenCalledTimes(1)
    expect(methods.confirmAnalysis).not.toHaveBeenCalled()
  })
})
