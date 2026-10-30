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
    expect(await screen.findByRole('alert')).toHaveTextContent('分析失败')
    vi.mocked(adapter.analyze).mockImplementationOnce(async (_request, { onProgress }) => onProgress({ analyzedMessages: 0, totalMessages: 0 }))
    await user.click(screen.getByRole('button', { name: '重试分析' }))
    await waitFor(() => expect(screen.getByText('分析完成')).toBeInTheDocument())
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('region', { name: '会话分析状态' })).not.toBeInTheDocument()
  })
})
