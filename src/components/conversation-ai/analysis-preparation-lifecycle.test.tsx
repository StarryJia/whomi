import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { AnalysisPreparation } from '../../shared/ai-contract'
import type { ConversationAiAdapter } from './types'
import { ConversationWorkspace } from './workspace'

it('核对期间取消并停用模型后，重新打开不残留已取消请求的等待提示', async () => {
  const user = userEvent.setup()
  let rejectPreparation!: (error: Error) => void
  const pending = new Promise<AnalysisPreparation>((_resolve, reject) => { rejectPreparation = reject })
  const adapter: ConversationAiAdapter = {
    models: [{ id: 'example-model', label: '示例模型' }], skills: [],
    respond: vi.fn(), analyze: vi.fn(), prepareAnalysis: vi.fn(() => pending),
  }
  const workspace = (current: ConversationAiAdapter) => <ConversationWorkspace conversationId="example-conversation"
    title="虚构会话" messageCount={7} references={[]} onClearReferences={() => {}} onJumpReference={() => {}}
    adapter={current}>{({ analysisControl }) => analysisControl}</ConversationWorkspace>
  const view = render(workspace(adapter))
  await user.click(screen.getByRole('button', { name: '整理成记忆' }))
  expect(screen.getByText('正在核对分析范围…')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '取消' }))
  view.rerender(workspace({ ...adapter, models: [] }))
  await act(async () => { rejectPreparation(new Error('旧核对请求失败')) })
  await user.click(screen.getByRole('button', { name: '整理成记忆' }))

  expect(screen.getByText('请在设置中添加模型。')).toBeVisible()
  expect(screen.queryByText('正在核对分析范围…')).not.toBeInTheDocument()
  expect(screen.queryByText('旧核对请求失败')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '生成记忆' })).not.toBeInTheDocument()
})
