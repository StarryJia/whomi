import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import App from '../../App'
import type { AiEvent, AnalysisTask } from '../../shared/ai-contract'
import type { DesktopApi } from '../../shared/desktop-api'
import { ConversationWorkspace } from '../conversation-ai/workspace'
import type { ConversationAiAdapter } from '../conversation-ai/types'
import { ConversationReader } from '../conversations'
import { InsightArticle } from './insight-article'
import { ExceptionNoticeProvider } from '../ui/exception-notices'

const report = {
  format: 'conversation-insights-v1' as const,
  aboutYou: [{ content: [{ text: '那次改期', citationId: 'citation-1' }] }],
  relationship: [{ content: [{ text: '你和 ta 一起核对了时间。' }] }],
  citations: [{ id: 'citation-1', conversationId: '1', fragments: [{ sources: [{ messageId: '10', revision: 'source-10' }] }] }],
  limitations: [],
}
const completed: AnalysisTask = {
  id: '24', conversationId: '1', conversationTitle: '小林', modelId: 'm', state: 'completed',
  analyzedMessages: 12, totalMessages: 12, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3, report,
  scope: { kind: 'dates', startDate: '2026-10-01', endDate: '2026-10-31', timezone: 'Asia/Shanghai' },
  sourceStartTimeMs: Date.UTC(2026, 9, 3), sourceEndTimeMs: Date.UTC(2026, 9, 3),
}
const baseAdapter: ConversationAiAdapter = { models: [{ id: 'm', label: '本机模型' }], skills: [], analyze: vi.fn(), respond: vi.fn() }

it('报告只有材料不足说明时保留模型的限定并沿用两节阅读结构', () => {
  render(<InsightArticle report={{ ...report, aboutYou: [], relationship: [], limitations: ['只有一次改期，暂时不能判断相处习惯。'] }} />)
  expect(screen.getByText('只有一次改期，暂时不能判断相处习惯。')).toBeVisible()
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['关于你', '你们的相处'])
})

it('管理正常读取后可浏览同名报告并在原位改名，失败保留输入及旧标题', async () => {
  const user = userEvent.setup()
  const renameAnalysis = vi.fn()
    .mockRejectedValueOnce(new Error('保存失败'))
    .mockResolvedValueOnce({ ...completed, title: '那次合作', eventSequence: 4 })
  const listAnalyses = vi.fn(async () => [completed, { ...completed, id: '23' }])
  const api = { ai: { listAnalyses, renameAnalysis, onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  const row = await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ })
  expect(screen.getByRole('button', { name: /小林.*会话洞察.*#23/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /新建报告|生成新记忆/ })).toBeNull()
  await user.click(row)
  expect(screen.getByRole('heading', { name: '会话洞察', level: 1 })).toBeVisible()
  expect(screen.getByRole('heading', { name: '关于你' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '你们的相处' })).toBeVisible()
  expect(screen.getByText('2026.10.01—2026.10.31')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '重命名' }))
  const title = screen.getByRole('textbox', { name: '报告名称' })
  expect(title).toHaveFocus()
  await user.clear(title)
  await user.type(title, '  那次合作  ')
  await user.click(screen.getByRole('button', { name: '保存' }))
  const notice = within(screen.getByRole('region', { name: '异常提醒' }))
  expect(await notice.findByRole('alert')).toHaveTextContent('无法保存报告名称')
  await user.click(notice.getByRole('button', { name: '展开详情' }))
  expect(notice.getByText('保存失败，请重试。')).toBeVisible()
  expect(title).toHaveValue('  那次合作  ')
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByRole('heading', { name: '那次合作', level: 1 })).toBeVisible()
  expect(renameAnalysis).toHaveBeenLastCalledWith({ taskId: '24', title: '那次合作' })
  await user.click(screen.getByRole('button', { name: '返回' }))
  expect(await screen.findByRole('button', { name: /小林.*那次合作.*#24/ })).toBeVisible()
  expect(screen.getByRole('button', { name: /小林.*会话洞察.*#23/ })).toBeVisible()
})

it('列表从无数据读取失败后重试，只有成功返回空结果才显示前往会话', async () => {
  const user = userEvent.setup()
  let fail!: (reason: Error) => void
  const listAnalyses = vi.fn(async (): Promise<AnalysisTask[]> => [])
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const api = { ai: { listAnalyses, onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  expect(screen.getByRole('status')).toHaveTextContent('正在读取报告列表')
  expect(screen.queryByText('暂无洞察报告')).toBeNull()
  await act(async () => fail(new Error('网络不可用')))
  const error = await screen.findByRole('alert')
  expect(error).toHaveTextContent('报告列表读取失败')
  expect(error).not.toHaveTextContent('网络')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByRole('button', { name: '前往会话' })).toBeVisible()
  expect(listAnalyses).toHaveBeenCalledTimes(2)
})

it('本人尚未确认时由入口发起现有成员选择，成功后需要再次点击才显示范围', async () => {
  const user = userEvent.setup()
  const adapter = { ...baseAdapter, analyze: vi.fn() }
  const listMembers = vi.fn(async () => [{ id: '1', displayName: '小周', accountId: null, confirmedSelf: false, selfHint: true }])
  const confirmSelf = vi.fn(async () => undefined)
  render(<ConversationReader conversation={{ id: '1', title: '小林', messages: [] }} messageCount={12}
    aiAdapter={adapter} api={{ listMembers, confirmSelf } as unknown as DesktopApi} />)
  await user.click(await screen.findByRole('button', { name: '取消' }))
  const entry = screen.getByRole('button', { name: '会话洞察' })
  await user.click(entry)
  expect(screen.getByRole('dialog')).toHaveTextContent('请先选择本人，再开始会话洞察。')
  expect(screen.queryByRole('button', { name: '开始洞察' })).toBeNull()
  await user.click(await screen.findByRole('radio', { name: /小周/ }))
  await user.click(screen.getByRole('button', { name: '设为本人' }))
  expect(confirmSelf).toHaveBeenCalledWith('1', '1')
  expect(screen.queryByRole('button', { name: '开始洞察' })).toBeNull()
  await user.click(entry)
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeVisible()
  expect(adapter.analyze).not.toHaveBeenCalled()
})

it('删除后迟到的报告事件和列表结果都不会恢复已删除的报告', async () => {
  const user = userEvent.setup()
  let publish!: (event: AiEvent) => void
  let resolveList!: (value: AnalysisTask[]) => void
  const listAnalyses = vi.fn(() => new Promise<AnalysisTask[]>(resolve => { resolveList = resolve }))
  const deleteAnalysis = vi.fn(async () => {})
  const api = { ai: { listAnalyses, deleteAnalysis, onEvent: (listener: typeof publish) => { publish = listener; return () => {} } } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  await act(async () => publish({ kind: 'analysis', snapshot: { ...completed, eventSequence: 2, state: 'running', report: undefined } }))
  await act(async () => resolveList([completed, { ...completed, id: '23' }]))
  await act(async () => publish({ kind: 'analysis', snapshot: completed }))
  expect(listAnalyses).toHaveBeenCalledTimes(2)
  const row = screen.getByRole('button', { name: /小林.*会话洞察.*#24/ })
  fireEvent.contextMenu(row)
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  const dialog = await screen.findByRole('dialog', { name: '删除报告' })
  expect(dialog).toHaveTextContent('#24')
  expect(dialog).toHaveTextContent('小林')
  expect(dialog).toHaveTextContent(/2026.10.01.*2026.10.31/)
  await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
  expect(deleteAnalysis).toHaveBeenCalledWith('24')
  await act(async () => publish({ kind: 'analysis', snapshot: { ...completed, eventSequence: 30 } }))
  await act(async () => resolveList([completed, { ...completed, id: '23' }]))
  expect(screen.queryByRole('button', { name: /小林.*会话洞察.*#24/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /小林.*会话洞察.*#23/ })).toBeVisible()
})

it('指定暂停任务只显示进度，关窗和开窗都不自动续跑，开始原任务后才允许继续', async () => {
  const user = userEvent.setup()
  const paused: AnalysisTask = { ...completed, state: 'stopped', analyzedMessages: 6, report: undefined,
    usage: { totalInputTokens: 100, cacheWriteTokens: 0 } }
  const continueAnalysis = vi.fn(async () => ({ taskId: paused.id, task: paused }))
  const adapter = { ...baseAdapter, continueAnalysis, watchAnalysis: vi.fn(async (_id, update) => update(paused)) } satisfies ConversationAiAdapter
  render(<ConversationWorkspace conversationId="1" title="小林" messageCount={12} references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter} openAnalysisOnEntry initialAnalysisTaskId={paused.id}>
    {({ analysisControl }) => analysisControl}
  </ConversationWorkspace>)
  expect(await screen.findByText('已暂停', { exact: true })).toBeVisible()
  expect(continueAnalysis).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '详情' }))
  expect(screen.getByText('缓存写入')).toBeVisible()
  expect(screen.queryByText('缓存读取')).toBeNull()
  await user.click(screen.getByRole('button', { name: '关闭会话洞察' }))
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  expect(continueAnalysis).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '继续洞察' }))
  expect(continueAnalysis).toHaveBeenCalledOnce()
  expect(continueAnalysis).toHaveBeenCalledWith(paused.id, expect.any(AbortSignal), expect.any(Function))
})

it('范围日期倒置后直接定位输入错误并阻止开始', async () => {
  const user = userEvent.setup()
  const adapter = { ...baseAdapter, analyze: vi.fn() }
  render(<ConversationWorkspace conversationId="1" title="小林" messageCount={12} references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>
    {({ analysisControl }) => analysisControl}
  </ConversationWorkspace>)
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  await user.click(screen.getByRole('radio', { name: '日期范围' }))
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-10-31' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-10-01' } })
  expect(screen.getByRole('alert')).toHaveTextContent('开始日期不能晚于结束日期')
  expect(screen.getByRole('button', { name: '开始洞察' })).toBeDisabled()
  expect(adapter.analyze).not.toHaveBeenCalled()
})

it('预算耗尽时仍可在原会话选择新范围，重新选择不会续跑耗尽的任务', async () => {
  const user = userEvent.setup()
  const expired: AnalysisTask = { ...completed, state: 'failed', report: undefined, error: '分析已达用量上限，请缩小范围。' }
  const continueAnalysis = vi.fn()
  const adapter = { ...baseAdapter, analyze: vi.fn(), continueAnalysis, watchAnalysis: async (_id, update) => update(expired) } satisfies ConversationAiAdapter
  render(<ConversationWorkspace conversationId="1" title="小林" messageCount={12} references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter} openAnalysisOnEntry initialAnalysisTaskId={expired.id}>
    {({ analysisControl }) => analysisControl}
  </ConversationWorkspace>)
  expect(await screen.findByRole('button', { name: '重试' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '再次洞察' }))
  expect(screen.getByRole('radio', { name: '日期范围' })).toBeInTheDocument()
  expect(continueAnalysis).not.toHaveBeenCalled()
  expect(adapter.analyze).not.toHaveBeenCalled()
})

it('展开洞察异常时保留原会话的进度和恢复操作', async () => {
  const user = userEvent.setup()
  const expired: AnalysisTask = { ...completed, state: 'failed', report: undefined, error: '分析已达用量上限，请缩小范围。' }
  const adapter = { ...baseAdapter, watchAnalysis: async (_id, update) => update(expired) } satisfies ConversationAiAdapter
  render(<ExceptionNoticeProvider><ConversationWorkspace conversationId="1" title="小林" messageCount={12} references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter} openAnalysisOnEntry initialAnalysisTaskId={expired.id}>
    {({ analysisControl }) => analysisControl}
  </ConversationWorkspace></ExceptionNoticeProvider>)

  const notices = await screen.findByRole('region', { name: '异常提醒' })
  await user.click(within(notices).getByRole('button', { name: '展开详情' }))
  expect(within(notices).getByText(expired.error!)).toBeVisible()
  expect(screen.getByRole('button', { name: '再次洞察' })).toBeVisible()
})

it('同一次洞察失败关闭后可折叠和重访列表，任务重试后的失败重新提醒', async () => {
  const user = userEvent.setup()
  const failed: AnalysisTask = { ...completed, state: 'failed', report: undefined, error: '连接失败，请重试。' }
  let publish!: (event: AiEvent) => void
  const api = { ai: { listAnalyses: async () => [failed],
    onEvent: (listener: typeof publish) => { publish = listener; return () => {} } } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  const openLibrary = () => user.click(screen.getByRole('button', { name: '对话洞察' }))
  const notices = () => screen.queryByRole('region', { name: '异常提醒' })
  await openLibrary()
  const first = within(await screen.findByRole('region', { name: '异常提醒' }))
  expect(first.getByRole('alert')).toHaveTextContent('生成失败')
  await user.click(first.getByRole('button', { name: '关闭提醒' }))
  const group = screen.getByRole('button', { name: /小林（1）/ })
  await user.click(group)
  await user.click(group)
  expect(notices()).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await openLibrary()
  expect(notices()).not.toBeInTheDocument()
  await act(async () => publish({ kind: 'analysis', snapshot: { ...failed, eventSequence: 4, usage: { inputTokens: 100 } } }))
  expect(notices()).not.toBeInTheDocument()

  await act(async () => publish({ kind: 'analysis', snapshot: { ...failed, state: 'running', error: undefined, eventSequence: 5 } }))
  expect(screen.getByRole('status')).toHaveTextContent('生成中')
  await act(async () => publish({ kind: 'analysis', snapshot: { ...failed, eventSequence: 6 } }))
  const next = within(await screen.findByRole('region', { name: '异常提醒' }))
  expect(next.getAllByRole('alert')).toHaveLength(1)
  await user.click(next.getByRole('button', { name: '展开详情' }))
  expect(next.getByText('连接失败，请重试。')).toBeVisible()
  await user.click(next.getByRole('button', { name: '关闭提醒' }))
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await act(async () => {
    publish({ kind: 'analysis', snapshot: { ...failed, state: 'running', error: undefined, eventSequence: 7 } })
    publish({ kind: 'analysis', snapshot: { ...failed, eventSequence: 8 } })
  })
  expect(notices()).not.toBeInTheDocument()
  await openLibrary()
  expect(within(await screen.findByRole('region', { name: '异常提醒' })).getByRole('alert')).toHaveTextContent('生成失败')
})

it('列表原位改名保存期间阻止取消和打开另一份报告，回执后恢复入口', async () => {
  const user = userEvent.setup()
  let finish!: (value: AnalysisTask) => void
  const renameAnalysis = vi.fn(() => new Promise<AnalysisTask>(resolve => { finish = resolve }))
  const api = { ai: { listAnalyses: async () => [completed, { ...completed, id: '23' }], renameAnalysis, onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  fireEvent.contextMenu(await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ }))
  await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
  const input = screen.getByRole('textbox', { name: '报告名称' })
  await user.clear(input)
  await user.type(input, '合作')
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: /小林.*会话洞察.*#23/ }))
  expect(input).toBeVisible()
  expect(screen.queryByRole('heading', { name: '关于你' })).not.toBeInTheDocument()
  await act(async () => finish({ ...completed, title: '合作', eventSequence: 4 }))
  expect(screen.getByRole('button', { name: /小林.*合作.*#24/ })).toBeVisible()
})
