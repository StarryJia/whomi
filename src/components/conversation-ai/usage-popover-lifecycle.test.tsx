import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { ConversationAiAdapter } from './types'
import { ConversationWorkspace } from './workspace'

it.each(['关闭 AI 对话', '显示对话列表'] as const)('键盘%s时一并关闭已打开的生成统计', async action => {
  const user = userEvent.setup()
  const adapter: ConversationAiAdapter = {
    models: [{ id: 'example-model', label: '示例模型' }], skills: [],
    respond: vi.fn(), analyze: vi.fn(), restoreThread: async () => [{
      id: 'example-turn', requestId: 'example-request', prompt: '虚构问题', referenceIds: [],
      modelId: 'example-model', text: '虚构回答', state: 'completed', usage: { outputTokens: 100 },
    }],
  }
  render(<ConversationWorkspace conversationId="example-conversation" title="虚构会话" references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>
    {({ chatControl }) => chatControl}
  </ConversationWorkspace>)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await screen.findByText('虚构回答')
  const summary = screen.getByRole('button', { name: '输出 100 token' })
  await user.click(summary)
  expect(screen.getByRole('region', { name: '生成统计' })).toBeVisible()
  if (action === '显示对话列表') act(() => screen.getByRole('region', { name: '对话消息' }).focus())
  await user.keyboard('{Escape}')
  await act(() => new Promise(resolve => setTimeout(resolve, 250)))
  expect(screen.getByRole('complementary', { name: 'AI 对话' })).toBeVisible()
  expect(screen.queryByRole('region', { name: '生成统计' })).not.toBeInTheDocument()
  expect(summary).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('region', { name: '生成统计' })).toBeVisible()
  const target = screen.getByRole('button', { name: action })
  for (let step = 0; step < 12 && document.activeElement !== target; step += 1) await user.tab({ shift: true })
  expect(target).toHaveFocus()
  await user.keyboard('{Enter}')

  if (action === '关闭 AI 对话') expect(screen.queryByRole('complementary', { name: 'AI 对话' })).not.toBeInTheDocument()
  else expect(screen.getByRole('navigation', { name: 'AI 对话列表' })).toBeVisible()
  expect(screen.queryByRole('region', { name: '生成统计' })).not.toBeInTheDocument()
  if (action === '关闭 AI 对话') await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  else await user.click(screen.getByRole('button', { name: '收起对话列表' }))
  expect(await screen.findByRole('button', { name: '输出 100 token' })).toHaveAttribute('aria-expanded', 'false')
})
