import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CherryMessages, type CherryMessageTurn } from './cherry/messages'
import type { RestoredConversationTurn } from './types'
import { ConversationWorkspace } from './workspace'

const restored: RestoredConversationTurn = {
  id: 'turn-1', requestId: 'request-1', prompt: '示例问题', referenceIds: [],
  modelId: 'a', text: '', state: 'completed',
}

async function showTurns(turns: RestoredConversationTurn[]) {
  const user = userEvent.setup()
  const respond = vi.fn(async () => ({ text: '重试成功' }))
  render(<ConversationWorkspace conversationId="example" title="示例" references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}}
    adapter={{ models: [{ id: 'a', label: '当前名称' }], skills: [], respond,
      restoreThread: async () => turns, analyze: async () => {} }}>
    {({ chatControl }) => chatControl}
  </ConversationWorkspace>)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await screen.findByText('示例问题')
  return { user, respond, log: within(screen.getByRole('log')) }
}

describe('迁移消息行为', () => {
  it('仅允许重试末轮停止的回答，并在原轮替换正文', async () => {
    const { user, respond, log } = await showTurns([
      { ...restored, id: 'older', requestId: 'older-request', prompt: '更早的提问', state: 'failed', error: '旧错误' },
      { ...restored, state: 'stopped', text: '停止前收到的正文' },
    ])
    expect(log.getByText('停止前收到的正文')).toBeVisible()
    const actions = log.getAllByRole('button', { name: '重试回答' })
    expect(actions).toHaveLength(1)
    await user.click(actions[0])
    expect(await log.findByText('重试成功')).toBeVisible()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ prompt: '示例问题' }), expect.anything())
    expect(log.getAllByText('示例问题')).toHaveLength(1)
    expect(log.queryByText('停止前收到的正文')).not.toBeInTheDocument()
  })

  it('空的完成回答显示完成状态且没有错误或重试动作', async () => {
    const { log } = await showTurns([{ ...restored }])
    await waitFor(() => expect(log.getByText('回答为空，请重新提问。')).toBeVisible())
    expect(log.queryByRole('alert')).not.toBeInTheDocument()
    expect(log.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument()
  })

  it('复制的回答保留前导空格、行尾空格及末尾换行', async () => {
    const raw = '  原始文本  \n下一行   \n'
    const { user, log } = await showTurns([{ ...restored, text: raw }])
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(log.getByRole('button', { name: '复制回答' }))
    expect(write).toHaveBeenCalledWith(raw)
  })

  it('统计标明整轮汇总，使用历史身份和累计耗时', async () => {
    const { user, log } = await showTurns([{ ...restored, text: '合计示例',
      modelIdentity: { id: 'a', version: 1, label: '原生成名称', model: 'original-model' },
      usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 100, firstTokenMs: 9000, durationMs: 10000,
        startedAt: 1720000000000, completedAt: 1720000060000 },
    }])
    await user.click(log.getByRole('button', { name: /输出 100/ }))
    const details = screen.getByRole('region', { name: '生成统计' })
    expect(details).toHaveTextContent('原生成名称')
    expect(details).toHaveTextContent('original-model')
    expect(details).not.toHaveTextContent('当前名称')
    expect(details).toHaveTextContent('1,000 Tokens')
    expect(details).toHaveTextContent('100 Token/秒')
    expect(details).toHaveTextContent('10 Token/秒')
    expect(details).toHaveTextContent('10 秒')
    expect(details).not.toHaveTextContent('60 秒')
    expect(within(details).queryByRole('button', { name: /调用明细|展开详情/ })).not.toBeInTheDocument()
  })
})

describe('Cherry 消息模块', () => {
  const turn: CherryMessageTurn = {
    id: 42, request: { requestId: 'request', conversationId: 'example', prompt: '问题正文', references: [], modelId: 'a' },
    text: '### 已生成标题\n\n| 示例 | 数值 |\n| --- | --- |\n| 值 | 1 |', status: 'running'
  }
  const renderReferences = () => <button type="button">查看示例引用</button>
  const onRetry = vi.fn()

  it('宿主确认用户发送后可让阅读中的列表返回最新消息', async () => {
    const handle = createRef<{ scrollToBottom(): void }>()
    render(<CherryMessages ref={handle} turns={[{ ...turn, status: 'done' }]} scopeKey="follow-after-send" running={false}
      onRetry={onRetry} renderReferences={renderReferences} />)
    await screen.findByRole('heading', { name: '已生成标题' })
    const viewport = screen.getByRole('region', { name: '对话消息' })
    Object.defineProperties(viewport, { scrollHeight: { value: 1400 }, clientHeight: { value: 640 } })
    fireEvent.wheel(viewport, { deltaY: -200 })
    viewport.scrollTop = 110

    expect(viewport.scrollTop).toBe(110)
    act(() => handle.current?.scrollToBottom())
    expect(viewport.scrollTop).toBe(760)
  })

  it('保存返回的持久编号并从流式移入历史时保留原问题和正文节点', async () => {
    const renderTurn = (value: CherryMessageTurn) => (
      <StrictMode>
        <CherryMessages turns={[value]} scopeKey="thread" running={value.status === 'running'}
          onRetry={onRetry} renderReferences={renderReferences} />
      </StrictMode>
    )
    const view = render(renderTurn(turn))
    const prompt = await screen.findByText('问题正文')
    await waitFor(() => expect(prompt).toBeVisible())
    const heading = await screen.findByRole('heading', { name: '已生成标题' })
    const table = screen.getByRole('table')
    expect(screen.getAllByRole('button', { name: '查看示例引用' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '复制回答' })).not.toBeInTheDocument()

    view.rerender(renderTurn({ ...turn, id: 'stored-42', status: 'done' }))

    expect(screen.getByText('问题正文')).toBe(prompt)
    expect(screen.getByRole('heading', { name: '已生成标题' })).toBe(heading)
    expect(screen.getByRole('table')).toBe(table)
    expect(screen.getByRole('button', { name: '复制回答' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /朗读|重新生成|编辑|分支/ })).not.toBeInTheDocument()
  })

  it('使用保存后的停止轮编号注册重试动作，并关闭统计弹层', async () => {
    const user = userEvent.setup()
    const stopped: CherryMessageTurn = { ...turn, id: 'stored-42', status: 'stopped', usage: { outputTokens: 8 } }
    const view = render(<CherryMessages turns={[stopped]} scopeKey="thread-a" running={false}
      onRetry={onRetry} renderReferences={renderReferences} />)
    await screen.findByText('已停止回答。')
    view.rerender(<CherryMessages turns={[stopped]} scopeKey="thread-a" running
      onRetry={onRetry} renderReferences={renderReferences} />)
    expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument()
    view.rerender(<CherryMessages turns={[stopped]} scopeKey="thread-a" running={false}
      onRetry={onRetry} renderReferences={renderReferences} />)
    await user.click(await screen.findByRole('button', { name: '重试回答' }))
    expect(onRetry).toHaveBeenLastCalledWith('stored-42')
    await user.click(screen.getByRole('button', { name: '输出 8 token' }))
    expect(screen.getByRole('region', { name: '生成统计' })).toBeVisible()
    expect(screen.getByRole('region', { name: '生成统计' })).toHaveTextContent('未知模型')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '生成统计' })).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: '生成统计' })).toBeVisible()

    view.rerender(<CherryMessages turns={[]} scopeKey="thread-b" running={false}
      onRetry={onRetry} renderReferences={renderReferences} />)
    expect(screen.queryByRole('region', { name: '生成统计' })).not.toBeInTheDocument()
    expect(screen.queryByText('问题正文')).not.toBeInTheDocument()
  })
})
