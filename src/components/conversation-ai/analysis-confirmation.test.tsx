import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationWorkspace } from './workspace'
import type { AnalysisResult, ConversationAiAdapter, GenerationUsage } from './types'
import type { AnalysisTask } from '../../shared/ai-contract'

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
    {({ analysisControl, chatControl }) => <>{analysisControl}{chatControl}</>}
  </ConversationWorkspace>)
  return { adapter, finish: (result: Parameters<typeof complete>[0]) => complete(result), update: (value: Parameters<typeof progress>[0]) => progress(value) }
}

describe('会话洞察确认与任务用量', () => {
  it('恢复暂停任务后，设置不兼容时保留断点并允许重新确认', async () => {
    const user = userEvent.setup()
    const paused: AnalysisTask = { id: 'saved', conversationId: 'c', modelId: 'm', state: 'stopped',
      analyzedMessages: 8, totalMessages: 24, skippedMessages: 0, usage: {}, valid: true, eventSequence: 2 }
    const adapter: ConversationAiAdapter = {
      models: [{ id: 'm', label: '本机模型' }], skills: [], respond: vi.fn(), analyze: vi.fn(),
      watchAnalysis: async (_id, update) => update(paused),
      continueAnalysis: vi.fn().mockRejectedValue({ code: 'PROCESSING_CHANGED', action: '请恢复原消息处理设置或重新生成。' }),
    }
    render(<ConversationWorkspace conversationId="c" title="测试" messageCount={24} references={[]}
      onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>
      {({ analysisControl }) => analysisControl}
    </ConversationWorkspace>)
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    await user.click(screen.getByRole('button', { name: '继续洞察' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请恢复原消息处理设置或重新生成。')
    expect(screen.getByText('已处理 8 / 24 条')).toBeVisible()
    expect(screen.queryByRole('button', { name: '继续洞察' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '再次洞察' }))
    expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled()
    expect(adapter.analyze).not.toHaveBeenCalled()
  })
  it('打开浮窗和取消确认都不开始任务，确认后才显示进度', async () => {
    const user = userEvent.setup()
    const { adapter } = setupAnalysis()
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    const confirmation = screen.getByRole('region', { name: '会话洞察状态' })
    expect(within(confirmation).getByText('当前会话：示例会话')).toBeInTheDocument()
    expect(within(confirmation).getByText('7 条消息')).toBeInTheDocument()
    expect(within(confirmation).queryByText('示例会话')).not.toBeInTheDocument()
    expect(within(confirmation).queryByText(/当前会话 7 条消息/)).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(adapter.analyze).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('region', { name: '会话洞察状态' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    await user.click(screen.getByRole('button', { name: '开始洞察' }))
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(adapter.analyze).toHaveBeenCalledWith({ conversationId: 'example-conversation', modelId: 'example-model' }, expect.anything())
  })

  it('显示累计用量并将完成任务标识交给结果导航，重新生成仍需确认', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const { adapter, finish, update } = setupAnalysis(navigate)
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    await user.click(screen.getByRole('button', { name: '开始洞察' }))
    act(() => update({ analyzedMessages: 3, totalMessages: 7, usage: { inputTokens: 1200, outputTokens: 180 }, outputTokensPerSecond: 58.3 }))
    await user.click(screen.getByRole('button', { name: '详情' }))
    const stats = screen.getByRole('group', { name: '分析用量' })
    expect(within(stats).getByText('1,200')).toBeInTheDocument()
    expect(within(stats).getByText('180')).toBeInTheDocument()
    expect(within(stats).getByText('平均输出速度').nextElementSibling).toHaveTextContent('58.3 词元/秒')
    expect(within(stats).queryByText('总耗时')).not.toBeInTheDocument()
    await act(async () => finish({ taskId: 'analysis-example-42', usage: { inputTokens: 2400, outputTokens: 386, outputTokensPerSecond: 58.3, durationMs: 2000 } }))
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(within(stats).getByText('2,400')).toBeInTheDocument()
    expect(within(stats).getByText('386')).toBeInTheDocument()
    expect(within(stats).getByText('平均输出速度').nextElementSibling).toHaveTextContent('193 词元/秒')
    expect(within(stats).queryByText('总耗时')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '查看报告' }))
    expect(navigate).toHaveBeenCalledWith('analysis-example-42')
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    await user.click(screen.getByRole('button', { name: '再次洞察' }))
    expect(screen.getByRole('button', { name: '开始洞察' })).toBeInTheDocument()
    expect(adapter.analyze).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '开始洞察' }))
    expect(adapter.analyze).toHaveBeenCalledTimes(2)
  })

  it('没有报告页面或用量回执时不假跳转、不补零', async () => {
    const user = userEvent.setup()
    const { finish } = setupAnalysis()
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    await user.click(screen.getByRole('button', { name: '开始洞察' }))
    await act(async () => finish({ taskId: 'analysis-example-42' }))
    expect(screen.queryByRole('button', { name: '查看报告' })).not.toBeInTheDocument()
    expect(screen.queryByText('分析管理尚未开放。')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '分析用量' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '详情' }))
    const stats = screen.getByRole('group', { name: '分析用量' })
    expect(within(stats).getByText('输入词元').nextElementSibling).toHaveTextContent('—')
    expect(within(stats).getByText('输出词元').nextElementSibling).toHaveTextContent('—')
  })

  it('停止后重新生成先回到确认，不将重新请求表达为恢复任务', async () => {
    const user = userEvent.setup()
    const { adapter } = setupAnalysis()
    await user.click(screen.getByRole('button', { name: '会话洞察' }))
    await user.click(screen.getByRole('button', { name: '开始洞察' }))
    await user.click(screen.getByRole('button', { name: '停止生成' }))
    expect(screen.getByText('已停止')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '再次洞察' }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始洞察' })).toBeInTheDocument()
    expect(adapter.analyze).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '开始洞察' }))
    expect(adapter.analyze).toHaveBeenCalledTimes(2)
    expect(screen.getByText('生成中')).toBeInTheDocument()
  })
})

it('工具栏圆环按已保存原文计数，未保存完不能显示百分之百', async () => {
  const user = userEvent.setup()
  const { update } = setupAnalysis()
  const trigger = screen.getByRole('button', { name: '会话洞察' })
  await user.click(trigger)
  await user.click(screen.getByRole('button', { name: '开始洞察' }))
  act(() => update({ analyzedMessages: 8, totalMessages: 24 }))
  expect(trigger).toHaveAccessibleDescription(/8.*24/)
  expect(Number(trigger.querySelector('circle[pathLength]')?.getAttribute('stroke-dasharray')?.split(' ')[0])).toBeCloseTo(100 / 3)
  act(() => update({ analyzedMessages: 14638, totalMessages: 14639 }))
  expect(screen.getByText('>99%')).toBeVisible()
})

it('仓库打开正在整理的任务只订阅指定编号；生成新记忆不误接旧任务', async () => {
  const active: AnalysisTask = { id: '7', conversationId: 'c', modelId: 'm', state: 'running',
    analyzedMessages: 9, totalMessages: 16, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3 }
  const adapter: ConversationAiAdapter = { models: [{ id: 'm', label: '本机模型' }], skills: [], respond: vi.fn(), analyze: vi.fn(),
    watchAnalysis: vi.fn(async (_id, publish) => publish(active)), continueAnalysis: vi.fn() }
  function workspace(taskId?: string) {
    return <ConversationWorkspace key={taskId ?? 'new'} conversationId="c" title="示例会话" messageCount={16} references={[]}
      openAnalysisOnEntry initialAnalysisTaskId={taskId} onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>
      {({ analysisControl }) => analysisControl}</ConversationWorkspace>
  }
  const { rerender } = render(workspace('7'))
  expect(await screen.findByText('已处理 9 / 16 条')).toBeVisible()
  expect(adapter.watchAnalysis).toHaveBeenCalledWith('c', expect.any(Function), expect.any(AbortSignal), '7')
  expect(adapter.continueAnalysis).not.toHaveBeenCalled()
  rerender(workspace())
  await waitFor(() => expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled())
  expect(adapter.watchAnalysis).toHaveBeenCalledTimes(1)
  expect(adapter.analyze).not.toHaveBeenCalled()
})
