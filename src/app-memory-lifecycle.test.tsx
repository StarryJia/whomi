import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { AiEvent, AnalysisTask } from './shared/ai-contract'
import type { DesktopApi } from './shared/desktop-api'
import type { ConversationAiAdapter } from './components/conversation-ai/types'

const memory: AnalysisTask = { id: '1', conversationId: '1', conversationTitle: '周末', modelId: 'm', state: 'completed',
  analyzedMessages: 2, totalMessages: 2, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3,
  report: { format: 'memory-v3', eventVotes: { EI: [0,0], SN: [0,0], TF: [0,0], JP: [3,0] }, dimensions: { EI: null, SN: null, TF: null, JP: 'J' }, events: [], relationship: '你们会一起商量。' } }

it('两段关系在安排方式上平票时并列列出关系，其他维度保持未知', async () => {
  const report = memory.report!
  if (!('format' in report) || report.format !== 'memory-v3') throw Error('fixture')
  const opposite = { ...memory, id: '2', conversationId: '2', conversationTitle: '旅行', report: { ...report, eventVotes: { ...report.eventVotes, JP: [0,13] }, dimensions: { ...report.dimensions, JP: 'P' } } }
  const api = { ai: { listAnalyses: async () => [memory, opposite], onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await userEvent.click(screen.getByRole('button', { name: '个人总览' }))
  const row = await screen.findByRole('group', { name: '判断 J / 感知 P' })
  expect(row).toHaveTextContent('关系票数持平')
  expect(row.querySelector('[role=img]')).toBeNull()
  expect(row).not.toHaveTextContent('较均衡')
  expect(row).toHaveTextContent('周末偏向提前安排')
  expect(row).toHaveTextContent('旅行偏向保留弹性')
  expect(screen.getByRole('group', { name: '外向 E / 内向 I' })).toHaveTextContent('尚待了解')
})

beforeEach(() => {
  const media = window.matchMedia('')
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, matches: query.includes('reduced-motion') }))
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    HTMLDialogElement.prototype.close = function () { this.open = false }
  }
})

it('后台更新列表失败时仍能读完原文并回到对应的仓库条目', async () => {
  const user = userEvent.setup()
  let listener: ((event: AiEvent) => void) | undefined
  const list = vi.fn(async () => [memory])
  const api = { ai: { listAnalyses: list, onEvent: (cb: typeof listener) => { listener = cb; return () => { listener = undefined } } } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.click(screen.getByRole('button', { name: '记忆仓库' }))
  const row = await screen.findByRole('button', { name: /周末.*#0001/ })
  const scroll = vi.spyOn(row, 'scrollIntoView')
  await user.click(row)
  expect(screen.getByRole('dialog')).toHaveTextContent('你们会一起商量。')
  list.mockRejectedValueOnce(Error('暂时无法读取列表'))
  await act(async () => listener?.({ kind: 'analysis', snapshot: memory }))
  expect(await screen.findByRole('alert')).toHaveTextContent('读取记忆失败')
  expect(screen.getByRole('dialog')).toHaveTextContent('你们会一起商量。')
  await user.click(screen.getByRole('button', { name: '关闭记忆' }))
  await waitFor(() => expect(row).toHaveFocus())
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
})

it('更正本人后只撤回该会话的贡献并重读暂停任务，保留对话草稿', async () => {
  const user = userEvent.setup()
  let changed = false
  const unrelated = { ...memory, id: '2', conversationId: '2', conversationTitle: '另一段关系' }
  const api = {
    listMembers: async () => [{ id: '1', displayName: '小林', confirmedSelf: true }, { id: '2', displayName: '小华', confirmedSelf: false }],
    confirmSelf: async () => { changed = true },
    ai: { listAnalyses: async () => changed ? new Promise<AnalysisTask[]>(() => {}) : [memory, unrelated], onEvent: () => () => {} },
  } as unknown as DesktopApi
  const adapter: ConversationAiAdapter = { models: [], skills: [], respond: vi.fn(), analyze: vi.fn(), continueAnalysis: vi.fn(),
    watchAnalysis: async (_id, update) => update({ ...memory, id: '3', report: undefined, state: 'stopped', valid: !changed }),
  }
  render(<App conversations={[{ id: '1', title: '周末', messages: [] }]} importApi={api} conversationAiAdapter={adapter} />)
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await user.click(await screen.findByRole('button', { name: '展开会话列表' }))
  await user.click(screen.getAllByRole('button', { name: '周末' })[0])
  await user.click(await screen.findByRole('button', { name: 'AI 对话' }))
  await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '等一等再发')
  await user.click(screen.getByRole('button', { name: '选择本人' }))
  await user.click(await screen.findByRole('radio', { name: '小华' }))
  await user.click(screen.getByRole('button', { name: '设为本人' }))
  await user.click(screen.getByRole('button', { name: '整理成记忆' }))
  expect(screen.queryByRole('button', { name: '继续生成' })).toBeNull()
  expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toHaveValue('等一等再发')
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  expect(screen.getByLabelText('各段关系中的表现')).toHaveTextContent('另一段关系')
  expect(screen.getByLabelText('各段关系中的表现')).not.toHaveTextContent('周末')
})

it('空库保留四维和 Spark，仓库有文稿预览与导入入口，问一问通过侧栏切回仓库', async () => {
  const user = userEvent.setup()
  render(<App conversations={[]} />)
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  expect(screen.getByRole('heading', { name: '人格偏好' })).toBeVisible()
  expect(screen.getAllByText('尚待了解')).toHaveLength(4)
  expect(screen.getByRole('heading', { name: /Spark/ })).toBeVisible()
  expect(screen.queryByRole('img', { name: /倾向/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: '记忆仓库' }))
  expect(screen.getByText('文稿预览')).toBeVisible()
  expect(screen.getByRole('button', { name: '导入聊天记录' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '问一问' }))
  expect(screen.getByRole('heading', { name: '目前还没有问题哦' })).toBeVisible()
  expect(screen.queryByRole('button', { name: /^返回/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '记忆仓库' }))
  expect(screen.getByRole('heading', { name: '记忆仓库' })).toBeVisible()
})

it('仓库可取消选会话并回到起点，选定后打开该会话的生成确认', async () => {
  const user = userEvent.setup()
  const adapter: ConversationAiAdapter = { models: [{id:'m',label:'测试模型'}], skills: [], analyze: vi.fn(), respond: vi.fn() }
  render(<App conversations={[{id:'1',title:'老同学',messages:[]},{id:'2',title:'周末同行',messages:[]}]} conversationAiAdapter={adapter} />)
  await user.click(screen.getByRole('button', {name:'记忆仓库'}))
  await user.click(await screen.findByRole('button', {name:'生成新记忆'}))
  await user.click(screen.getByRole('button', {name:'取消选择'}))
  expect(screen.getByText('文稿预览')).toBeVisible()
  await user.click(screen.getByRole('button', {name:'生成新记忆'}))
  await user.click(screen.getByRole('button', {name:/周末同行/}))
  expect(await screen.findByRole('heading', {name:'整理成记忆'})).toBeVisible()
  expect(adapter.analyze).not.toHaveBeenCalled()
})

it('一段关系已可判断时显示对应维度的关系数并能阅读来源', async () => {
  const user = userEvent.setup()
  const api = { ai:{ listAnalyses: async () => [memory], onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.click(screen.getByRole('button', { name:'个人总览' }))
  const approach = await screen.findByRole('group', { name:'判断 J / 感知 P' })
  await waitFor(() => expect(approach).toHaveTextContent('再有一段关系'))
  expect(approach.querySelector('[role=img]')).toBeNull()
  await user.click(screen.getByRole('button', {name:'周末'}))
  expect(await screen.findByRole('dialog')).toHaveTextContent('你们会一起商量。')
})

it('Hello 悬停预览不挂载私人的会话标题或发现内容', async () => {
  const user = userEvent.setup()
  const privateName = '虚构的私密会话名称'
  const api = { ai: {listAnalyses: async () => [{...memory, conversationTitle: privateName}], onEvent: () => () => {}} } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.hover(screen.getByRole('button', {name:/进入个人总览/}))
  expect(document.querySelector('.hello-cover-preview')).not.toHaveTextContent(privateName)
  await user.click(screen.getByRole('button', {name:'个人总览'}))
  expect(await screen.findByRole('button', {name:privateName})).toBeVisible()
})

it('启动时预读一次，读取中进入总览不会误报空库或重新请求', async () => {
  let loaded!: (tasks: AnalysisTask[]) => void
  const listAnalyses = vi.fn(() => new Promise<AnalysisTask[]>(resolve => { loaded = resolve }))
  const api = { ai: { listAnalyses, onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  expect(listAnalyses).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: /进入个人总览/ }))
  expect(screen.getByText('正在读取个人总览…')).toBeVisible()
  expect(screen.queryByRole('button', { name: '导入聊天记录' })).toBeNull()
  await act(async () => loaded([memory]))
  expect(await screen.findByRole('button', { name: '周末' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '记忆仓库' }))
  expect(listAnalyses).toHaveBeenCalledTimes(1)
})

it('初读与运行进度交错时保留最新版本和删除结果', async () => {
  let listener!: (event: AiEvent) => void
  let loaded!: (tasks: AnalysisTask[]) => void
  const partial: AnalysisTask = { ...memory, id: '10', state: 'running', totalMessages: 12, report: undefined }
  const api = { ai: { listAnalyses: () => new Promise<AnalysisTask[]>(resolve => { loaded = resolve }),
    onEvent: (callback: typeof listener) => { listener = callback; return () => {} } } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await userEvent.click(screen.getByRole('button', { name: '记忆仓库' }))
  await act(async () => {
    listener({ kind: 'analysis', snapshot: { ...partial, analyzedMessages: 3, eventSequence: 2 } })
    listener({ kind: 'analysis-deleted', taskId: '1', conversationId: '1' })
    loaded([memory, { ...partial, analyzedMessages: 8, eventSequence: 5 }])
  })
  expect(screen.getByRole('button', { name: /#0010/ })).toHaveTextContent('8 / 12')
  expect(screen.queryByRole('button', { name: /#0001/ })).toBeNull()
})
