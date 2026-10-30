import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationWorkspace } from './workspace'
import type { ConversationAiAdapter, ConversationRequest } from './types'

function fakeAdapter(): ConversationAiAdapter {
  return { models: [{ id: 'model', label: '示例模型' }], skills: [{ id: 'review', label: '沟通复盘' }],
    respond: vi.fn(async (_request, { onText }) => { onText('流式内容'); return { text: '完整回答', usage: { outputTokens: 386, outputTokensPerSecond: 62.1 } } }),
    analyze: vi.fn(async (_request, { onProgress }) => { onProgress({ analyzedMessages: 2, totalMessages: 7, outputTokensPerSecond: 58.3 }) }),
  }
}
function Workspace({ adapter }: { adapter?: ConversationAiAdapter }) {
  return <ConversationWorkspace conversationId="c" title="虚构会话" messageCount={7} references={[]}
    onClearReferences={vi.fn()} onJumpReference={vi.fn()} adapter={adapter}>
    {({ analysisControl, composer }) => <section>{analysisControl}{composer}</section>}
  </ConversationWorkspace>
}

describe('对话与后台分析', () => {
  it('列表消息数过期时以后台准备范围为准，允许确认真实材料', async () => {
    const user = userEvent.setup(), adapter = fakeAdapter()
    adapter.prepareAnalysis = async () => ({ token: 'verified', conversationId: 'c', title: '后台会话', selfName: '本人', totalMessages: 1, analyzableMessages: 1, snapshotMaxId: '1', expiresAt: Date.now() + 10000,
      model: { id: 'model', label: '模型', model: 'm', baseUrl: 'http://localhost:9900/v1', contextWindow: 8000, maxTokens: 1000, enabled: true, version: 1, hasCredential: false } })
    render(<ConversationWorkspace conversationId="c" title="会话" messageCount={0} references={[]} onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>{({ analysisControl, composer }) => <>{analysisControl}{composer}</>}</ConversationWorkspace>)
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(await screen.findByRole('button', { name: '确认分析' }))
    expect(adapter.analyze).toHaveBeenCalledWith(expect.objectContaining({ preparationToken: 'verified' }), expect.anything())
  })
  it('部分请求缺少用量时明确标记统计不完整', async () => {
    const user = userEvent.setup(), adapter = fakeAdapter()
    adapter.respond = async () => ({ text: '可读的回答', usage: { outputTokens: 100, incomplete: true } })
    render(<Workspace adapter={adapter} />)
    await user.type(screen.getByRole('textbox'), '我的问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(await screen.findByText('统计不完整')).toBeInTheDocument()
  })
  it('后端准备完成才允许确认，展示后台核对的身份与范围；取消零分析', async () => {
    const user = userEvent.setup()
    const adapter = fakeAdapter()
    let complete: (value: Awaited<ReturnType<NonNullable<ConversationAiAdapter['prepareAnalysis']>>>) => void = () => {}
    adapter.prepareAnalysis = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<ConversationAiAdapter['prepareAnalysis']>>>>(resolve => { complete = resolve }))
    render(<Workspace adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    expect(screen.queryByRole('button', { name: '确认分析' })).not.toBeInTheDocument()
    act(() => complete({ token: 'verified', conversationId: 'c', title: '后台会话', selfName: '已确认的本人', totalMessages: 12,
      analyzableMessages: 9, snapshotMaxId: '12', expiresAt: Date.now() + 10000,
      model: { id: 'model', label: '后台模型', model: 'm', baseUrl: 'https://example.test', contextWindow: 8192, maxTokens: 1024, version: 1, enabled: true, hasCredential: true } }))
    expect(await screen.findByText('本人：已确认的本人')).toBeInTheDocument()
    expect(screen.getByText(/12 条消息.*9 条可分析/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(adapter.analyze).not.toHaveBeenCalled()
  })
  it.each([new Error('请先确认本人身份。'), { code: 'IDENTITY_REQUIRED', action: '请先确认本人身份。' }])('准备失败展示操作指引，不显示确认按钮或调用分析：%j', async error => {
    const user = userEvent.setup(), adapter = fakeAdapter()
    adapter.prepareAnalysis = vi.fn(async () => { throw error })
    render(<Workspace adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请先确认本人身份')
    expect(screen.queryByRole('button', { name: '确认分析' })).not.toBeInTheDocument()
    expect(adapter.analyze).not.toHaveBeenCalled()
  })
  it('正式线程恢复后可查看原回答，关闭侧窗不停止；离页仅解除观察', async () => {
    const user = userEvent.setup(), adapter = fakeAdapter()
    let signal: AbortSignal | undefined
    adapter.watchThread = vi.fn(async (_id, update, observerSignal) => {
      signal = observerSignal
      update([{ id: 'persisted', requestId: 'original', prompt: '原先的问题', referenceIds: ['9'], modelId: 'model', text: '已保存的回答', state: 'completed', usage: {} }])
    })
    const view = render(<Workspace adapter={adapter} />)
    await user.click(await screen.findByRole('button', { name: '继续 AI 对话' }))
    expect(screen.getByText('已保存的回答')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭 AI 对话' }))
    expect(signal?.aborted).toBe(false)
    view.unmount()
    expect(signal?.reason).toBe('detach')
  })
  it('恢复已有分析状态，不重新准备或自动继续付费任务', async () => {
    const user = userEvent.setup(), adapter = fakeAdapter()
    adapter.prepareAnalysis = vi.fn()
    adapter.watchAnalysis = vi.fn(async (_id, update) => update({ id: 'old-task', conversationId: 'c', modelId: 'model',
      state: 'interrupted', analyzedMessages: 3, totalMessages: 7, skippedMessages: 0, usage: { outputTokens: 20 }, valid: true, eventSequence: 2 }))
    render(<Workspace adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    expect(screen.getByText('已分析 3 / 7 条')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('分析已中断')
    expect(adapter.prepareAnalysis).not.toHaveBeenCalled()
    expect(adapter.analyze).not.toHaveBeenCalled()
  })
  it('请求未结束时替换适配器，取消旧任务并允许重新发送', async () => {
    const user = userEvent.setup()
    const oldAdapter = fakeAdapter()
    let oldSignal: AbortSignal | undefined
    oldAdapter.respond = vi.fn((_request, { signal }) => { oldSignal = signal; return new Promise<{ text: string }>(() => {}) })
    const view = render(<Workspace adapter={oldAdapter} />)
    await user.type(screen.getByRole('textbox'), '保留问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    const nextAdapter = fakeAdapter()
    view.rerender(<Workspace adapter={nextAdapter} />)
    expect(oldSignal?.aborted).toBe(true)
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(await screen.findByText('完整回答')).toBeInTheDocument()
    expect(nextAdapter.respond).toHaveBeenCalledTimes(1)
  })
  it('没有模型时保留草稿，不生成回答、进度或统计', async () => {
    const user = userEvent.setup()
    render(<Workspace />)
    await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '我的问题')
    expect(screen.getByRole('button', { name: '发送给 AI' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    expect(screen.getByText('暂无可用模型。连接模型后可分析当前会话。')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
  })

  it('发送后只保留一个编辑器和模型选择，统计缺失项不显示为零', async () => {
    const user = userEvent.setup()
    render(<Workspace adapter={fakeAdapter()} />)
    await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '帮我梳理一下')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(await screen.findByText('完整回答')).toBeInTheDocument()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getAllByRole('combobox', { name: '对话模型' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: /输出 386 token/ }))
    expect(within(screen.getByRole('region', { name: '生成统计' })).getAllByText('未提供')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '生成统计' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭 AI 对话' }))
    await user.click(screen.getByRole('button', { name: '继续 AI 对话' }))
    expect(screen.getByText('完整回答')).toBeInTheDocument()
  })

  it('失败重试沿用原请求并保留草稿，不重复添加提问', async () => {
    const user = userEvent.setup()
    const adapter = fakeAdapter()
    vi.mocked(adapter.respond).mockRejectedValueOnce(new Error('连接失败，请重试。'))
    render(<Workspace adapter={adapter} />)
    await user.type(screen.getByRole('textbox'), '保留我的问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('连接失败')
    expect(screen.getByRole('textbox')).toHaveValue('保留我的问题')
    await user.click(screen.getByRole('button', { name: '重试回答' }))
    expect(await screen.findByText('完整回答')).toBeInTheDocument()
    expect(screen.getByRole('log').querySelectorAll('.conversation-user-turn')).toHaveLength(1)
    expect(vi.mocked(adapter.respond).mock.calls[0][0]).toEqual(vi.mocked(adapter.respond).mock.calls[1][0])
  })

  it('停止后忽略晚到内容，卸载同时取消两个任务', async () => {
    const user = userEvent.setup()
    const adapter = fakeAdapter()
    let chatOptions: Parameters<ConversationAiAdapter['respond']>[1]
    let analysisOptions: Parameters<ConversationAiAdapter['analyze']>[1]
    adapter.respond = vi.fn((_request: ConversationRequest, options) => { chatOptions = options; return new Promise<{ text: string }>(() => {}) })
    adapter.analyze = vi.fn((_request, options) => { analysisOptions = options; return new Promise<void>(() => {}) })
    const view = render(<Workspace adapter={adapter} />)
    await user.type(screen.getByRole('textbox'), '慢慢回答')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    act(() => chatOptions.onText('已有片段'))
    await user.click(screen.getByRole('button', { name: '停止回答' }))
    act(() => chatOptions.onText('晚到片段'))
    expect(chatOptions!.signal.aborted).toBe(true)
    expect(screen.getByText('已有片段')).toBeInTheDocument()
    expect(screen.queryByText('晚到片段')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    expect(adapter.analyze).toHaveBeenCalledWith({ conversationId: 'c', modelId: 'model' }, expect.anything())
    view.unmount()
    expect(analysisOptions!.signal.aborted).toBe(true)
  })

  it('分析失败后可重试，零总数的进度不产生无效百分比', async () => {
    const user = userEvent.setup()
    const adapter = fakeAdapter()
    vi.mocked(adapter.analyze).mockRejectedValueOnce(new Error('分析失败，请重试。'))
    render(<Workspace adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('分析失败')
    vi.mocked(adapter.analyze).mockImplementationOnce(async (_request, { onProgress }) => onProgress({ analyzedMessages: 0, totalMessages: 0 }))
    await user.click(screen.getByRole('button', { name: '重试分析' }))
    expect(adapter.analyze).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    await waitFor(() => expect(screen.getByText('分析完成')).toBeInTheDocument())
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('region', { name: '会话分析状态' })).not.toBeInTheDocument()
  })
})
