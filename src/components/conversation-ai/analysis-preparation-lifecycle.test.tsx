import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { expect, it, vi } from 'vitest'
import type { AnalysisPreparation } from '../../shared/ai-contract'
import type { AnalysisResult, ConversationAiAdapter } from './types'
import { ConversationWorkspace } from './workspace'

function setupPreparation({ delayed = false, strict = false, analyze = async () => ({ taskId: 'example-task' }) }: {
  delayed?: boolean
  strict?: boolean
  analyze?: ConversationAiAdapter['analyze']
} = {}) {
  const snapshots = new Set<string>()
  const pending: (() => void)[] = []
  let sequence = 0
  const adapter: ConversationAiAdapter = {
    models: [{ id: 'example-model', label: '示例模型' }, { id: 'second-model', label: '另一模型' }], skills: [],
    respond: vi.fn(), analyze,
    prepareAnalysis: async request => {
      const token = `preparation-${++sequence}`
      snapshots.add(token)
      const value: AnalysisPreparation = { token, conversationId: request.conversationId, title: '虚构会话',
        selfName: '本人', scope: request.scope, totalMessages: 7, analyzableMessages: 7,
        snapshotMaxId: '7', expiresAt: Date.now() + 60_000,
        model: { id: request.modelId, label: '示例模型', model: 'example', baseUrl: 'https://example.test',
          contextWindow: 8000, maxTokens: 1000, version: 1, enabled: true, hasCredential: true } }
      if (delayed) return new Promise<AnalysisPreparation>(resolve => pending.push(() => resolve(value)))
      return value
    },
    discardAnalysisPreparation: async token => { snapshots.delete(token) },
  }
  const workspace = <ConversationWorkspace conversationId="example-conversation" title="虚构会话" messageCount={7}
    openAnalysisOnEntry={strict}
    sourceStartTimeMs={Date.parse('2026-10-01T12:00:00Z')} sourceEndTimeMs={Date.parse('2026-10-02T12:00:00Z')}
    references={[]} onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>
    {({ analysisControl }) => analysisControl}
  </ConversationWorkspace>
  const view = render(strict ? <StrictMode>{workspace}</StrictMode> : workspace)
  return { snapshots, view, completePreparation: () => pending.shift()!() }
}

it.each(['取消', '卸载'] as const)('%s洞察设置时释放尚未提交的准备快照', async action => {
  const user = userEvent.setup()
  const { snapshots, view } = setupPreparation()
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled())
  expect([...snapshots]).toEqual(['preparation-1'])

  if (action === '取消') await user.click(screen.getByRole('button', { name: '取消' }))
  else view.unmount()

  await waitFor(() => expect([...snapshots]).toEqual([]))
})

it.each(['模型', '范围'] as const)('改变%s时仅保留当前准备快照', async setting => {
  const user = userEvent.setup()
  const { snapshots } = setupPreparation()
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled())
  expect([...snapshots]).toEqual(['preparation-1'])

  if (setting === '模型') {
    await user.click(screen.getByRole('combobox', { name: '分析模型' }))
    await user.click(screen.getByRole('option', { name: '另一模型' }))
  } else await user.click(screen.getByRole('radio', { name: '日期范围' }))

  await waitFor(() => expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled())
  expect([...snapshots]).toEqual(['preparation-2'])
})

it.each(['取消', '卸载'] as const)('%s后收到的准备结果仍释放快照', async action => {
  const user = userEvent.setup()
  const { snapshots, view, completePreparation } = setupPreparation({ delayed: true })
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeDisabled()
  expect([...snapshots]).toEqual(['preparation-1'])

  if (action === '取消') await user.click(screen.getByRole('button', { name: '取消' }))
  else view.unmount()
  await act(async () => completePreparation())

  expect([...snapshots]).toEqual([])
})

it('严格模式重复运行准备时释放已失效结果并保留当前结果', async () => {
  const user = userEvent.setup()
  const { snapshots, completePreparation } = setupPreparation({ delayed: true, strict: true })
  expect([...snapshots]).toEqual(['preparation-1', 'preparation-2'])

  await act(async () => completePreparation())
  expect([...snapshots]).toEqual(['preparation-2'])
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeDisabled()
  await act(async () => completePreparation())
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled()
  expect([...snapshots]).toEqual(['preparation-2'])

  await user.click(screen.getByRole('button', { name: '取消' }))
  expect([...snapshots]).toEqual([])
})

it('提交确认尚未返回时保留快照，离页后确认失败才释放', async () => {
  const user = userEvent.setup()
  let rejectConfirmation!: (error: Error) => void
  const confirmation = new Promise<AnalysisResult>((_resolve, reject) => { rejectConfirmation = reject })
  const { snapshots, view } = setupPreparation({ analyze: async () => confirmation })
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始洞察' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始洞察' }))

  expect(screen.getByRole('progressbar')).toBeInTheDocument()
  expect([...snapshots]).toEqual(['preparation-1'])
  view.unmount()
  expect([...snapshots]).toEqual(['preparation-1'])
  await act(async () => rejectConfirmation(new Error('确认失败')))

  expect([...snapshots]).toEqual([])
})

it('核对期间不展示内部准备提示，取消并停用模型后不残留旧请求状态', async () => {
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
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  expect(adapter.prepareAnalysis).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('正在核对分析范围…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '取消' }))
  view.rerender(workspace({ ...adapter, models: [] }))
  await act(async () => { rejectPreparation(new Error('旧核对请求失败')) })
  await user.click(screen.getByRole('button', { name: '会话洞察' }))

  expect(within(screen.getByRole('region', { name: '会话洞察状态' })).getByText('暂无可用模型')).toBeVisible()
  expect(screen.queryByText('正在核对分析范围…')).not.toBeInTheDocument()
  expect(screen.queryByText('旧核对请求失败')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeDisabled()
})
