import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationWorkspace } from './workspace'
import type { AnalysisResult, ConversationAiAdapter, GenerationUsage } from './types'

function setupAnalysis(onOpenAnalysisResult?: (taskId: string) => void) {
  let complete: (result: { taskId: string; usage?: GenerationUsage }) => void = () => {}
  let progress: Parameters<ConversationAiAdapter['analyze']>[1]['onProgress'] = () => {}
  const adapter: ConversationAiAdapter = {
    models: [{ id: 'example-model', label: '示例模型' }], skills: [],
    respond: async () => ({ text: '示例回答' }),
    analyze: vi.fn((_request, options) => {
      progress = options.onProgress
      return new Promise<AnalysisResult>(resolve => { complete = resolve })
    }),
  }
  render(<ConversationWorkspace conversationId="example-conversation" title="示例会话" messageCount={7}
    references={[]} onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}
    onOpenAnalysisResult={onOpenAnalysisResult}>
    {({ analysisControl, composer }) => <>{analysisControl}{composer}</>}
  </ConversationWorkspace>)
  return { adapter, finish: (result: Parameters<typeof complete>[0]) => complete(result), update: (value: Parameters<typeof progress>[0]) => progress(value) }
}

describe('会话分析确认与任务用量', () => {
  it('打开浮窗和取消确认都不开始任务，确认后才显示进度', async () => {
    const user = userEvent.setup()
    const { adapter } = setupAnalysis()
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    const confirmation = screen.getByRole('region', { name: '会话分析状态' })
    expect(within(confirmation).getByText('根据当前会话的全部聊天内容，生成一份分析报告。')).toBeInTheDocument()
    expect(within(confirmation).queryByText('示例会话')).not.toBeInTheDocument()
    expect(within(confirmation).queryByText(/当前会话 7 条消息/)).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(adapter.analyze).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('region', { name: '会话分析状态' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(adapter.analyze).toHaveBeenCalledWith({ conversationId: 'example-conversation', modelId: 'example-model' }, expect.anything())
  })

  it('显示累计用量并将完成任务标识交给结果导航，重新分析仍需确认', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const { adapter, finish, update } = setupAnalysis(navigate)
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    act(() => update({ analyzedMessages: 3, totalMessages: 7, usage: { inputTokens: 1200, outputTokens: 180 }, outputTokensPerSecond: 58.3 }))
    const stats = screen.getByRole('group', { name: '分析用量' })
    expect(within(stats).getByText('1,200')).toBeInTheDocument()
    expect(within(stats).getByText('180')).toBeInTheDocument()
    expect(within(stats).getByText('总耗时').nextElementSibling).toHaveTextContent('未提供')
    await act(async () => finish({ taskId: 'analysis-example-42', usage: { inputTokens: 2400, outputTokens: 386, outputTokensPerSecond: 58.3, durationMs: 2000 } }))
    expect(screen.getByText('分析完成')).toBeInTheDocument()
    expect(within(stats).getByText('2,400')).toBeInTheDocument()
    expect(within(stats).getByText('386')).toBeInTheDocument()
    expect(within(stats).getByText('总耗时').nextElementSibling).toHaveTextContent('2 秒')
    await user.click(screen.getByRole('button', { name: '查看分析结果' }))
    expect(navigate).toHaveBeenCalledWith('analysis-example-42')
    await user.click(screen.getByRole('button', { name: '重新分析' }))
    expect(screen.getByRole('button', { name: '确认分析' })).toBeInTheDocument()
    expect(adapter.analyze).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    expect(adapter.analyze).toHaveBeenCalledTimes(2)
  })

  it('没有报告页面或用量回执时不假跳转、不补零', async () => {
    const user = userEvent.setup()
    const { finish } = setupAnalysis()
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    await act(async () => finish({ taskId: 'analysis-example-42' }))
    expect(screen.queryByRole('button', { name: '查看分析结果' })).not.toBeInTheDocument()
    expect(screen.queryByText('分析管理尚未开放。')).not.toBeInTheDocument()
    expect(screen.getByText('未提供用量统计。')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '分析用量' })).not.toBeInTheDocument()
  })

  it('停止后重新分析先回到确认，不将重新请求表达为恢复任务', async () => {
    const user = userEvent.setup()
    const { adapter } = setupAnalysis()
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    await user.click(screen.getByRole('button', { name: '停止分析' }))
    expect(screen.getByText('已停止')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新分析' }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认分析' })).toBeInTheDocument()
    expect(adapter.analyze).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '确认分析' }))
    expect(adapter.analyze).toHaveBeenCalledTimes(2)
    expect(screen.getByText('正在分析')).toBeInTheDocument()
  })
})
