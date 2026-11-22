import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { AiEvent, AnalysisTask } from './shared/ai-contract'
import type { DesktopApi } from './shared/desktop-api'
import type { ConversationAiAdapter } from './components/conversation-ai/types'
import { clearFixtureDrafts, expectComposerText, pasteComposerText } from './test/cherry-composer-helpers'

beforeEach(() => clearFixtureDrafts('1'))

const judgment = { dimension: 'JP' as const, direction: 'J' as const, text: '你会提前安排。',
  supportingSources: [{ messageId: '1', revision: 'revision-1' }], counterexampleSources: [], alternativeExplanations: [], limitations: [] }
const report = { format: 'conversation-insights-v1' as const, aboutYou: [],
  relationship: [{ content: [{ text: '你们会一起商量。' }] }], judgments: [judgment], citations: [], limitations: [] }
const insightTask: AnalysisTask = { id: '1', conversationId: '1', conversationTitle: '周末', title: '周末的安排', modelId: 'm', state: 'completed',
  analyzedMessages: 2, totalMessages: 2, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3, report }

it('两段关系在安排方式上平票时并列列出关系，其他维度保持未知', async () => {
  const opposite = { ...insightTask, id: '2', conversationId: '2', conversationTitle: '我和装修进度', counterpartName: '貂蝉',
    report: { ...report, judgments: [{ ...judgment, direction: 'P' as const }] } }
  const group = { ...insightTask, conversationTitle: '我和同学们' }
  const api = {
    listConversations: async () => ({ items: [
      { id: '1', title: group.conversationTitle, kind: 'group' }, { id: '2', title: opposite.conversationTitle, kind: 'direct' },
    ], nextCursor: null }),
    ai: { listAnalyses: async () => [group, opposite], onEvent: () => () => {} },
  } as unknown as DesktopApi
  render(<App preview importApi={api} />)
  await userEvent.click(screen.getByRole('button', { name: '个人总览' }))
  const row = await screen.findByRole('group', { name: '判断 J / 感知 P' })
  expect(row).toHaveTextContent('关系票数持平')
  expect(row.querySelector('[role=img]')).toBeNull()
  expect(row).not.toHaveTextContent('较均衡')
  expect(row).toHaveTextContent('在「我和同学们」这段聊天中，你更习惯提前安排')
  expect(row).toHaveTextContent('与貂蝉相处时，你更习惯保留弹性')
  expect(screen.getByRole('button', { name: /与貂蝉相处时.*我和装修进度.*你的倾向/ })).toBeVisible()
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

it('后台更新列表失败时仍能读完原文并回到对应的报告条目', async () => {
  const user = userEvent.setup()
  let listener: ((event: AiEvent) => void) | undefined
  const list = vi.fn(async () => [insightTask])
  const api = { ai: { listAnalyses: list, onEvent: (cb: typeof listener) => { listener = cb; return () => { listener = undefined } } } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  const row = await screen.findByRole('button', { name: /周末的安排.*#1/ })
  await user.click(row)
  expect(screen.getByRole('article')).toHaveTextContent('你们会一起商量。')
  list.mockRejectedValueOnce(Error('暂时无法读取列表'))
  await act(async () => listener?.({ kind: 'analysis', snapshot: insightTask }))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('article')).toHaveTextContent('你们会一起商量。')
  await user.click(screen.getByRole('button', { name: '返回' }))
  await waitFor(() => expect(row).toHaveFocus())
  expect(await screen.findByText('报告列表读取失败')).toBeVisible()
})

it('更正本人后只撤回该会话的贡献并重读暂停任务，保留对话草稿', async () => {
  const user = userEvent.setup()
  let changed = false
  const unrelated = { ...insightTask, id: '2', conversationId: '2', conversationTitle: '另一段关系', title: '另一段关系的洞察' }
  const api = {
    listMembers: async () => [{ id: '1', displayName: '小林', confirmedSelf: true }, { id: '2', displayName: '小华', confirmedSelf: false }],
    confirmSelf: async () => { changed = true },
    ai: { listAnalyses: async () => changed ? new Promise<AnalysisTask[]>(() => {}) : [insightTask, unrelated], onEvent: () => () => {} },
  } as unknown as DesktopApi
  const adapter: ConversationAiAdapter = { models: [], skills: [], respond: vi.fn(), analyze: vi.fn(), continueAnalysis: vi.fn(),
    watchAnalysis: async (_id, update) => update({ ...insightTask, id: '3', report: undefined, state: 'stopped', valid: !changed }),
  }
  render(<App conversations={[{ id: '1', title: '周末', messages: [] }]} importApi={api} conversationAiAdapter={adapter} />)
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await user.click(await screen.findByRole('button', { name: '展开会话列表' }))
  await user.click(screen.getAllByRole('button', { name: '周末' })[0])
  await user.click(await screen.findByRole('button', { name: 'AI 对话' }))
  await pasteComposerText('等一等再发')
  await user.click(screen.getByRole('button', { name: '选择本人' }))
  await user.click(await screen.findByRole('radio', { name: '小华' }))
  await user.click(screen.getByRole('button', { name: '设为本人' }))
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  expect(screen.queryByRole('button', { name: '继续洞察' })).toBeNull()
  await expectComposerText('等一等再发')
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  expect(screen.getByLabelText('你在不同关系中的表现')).toHaveTextContent('另一段关系')
  expect(screen.getByLabelText('你在不同关系中的表现')).not.toHaveTextContent('周末')
})

it('空库保留四维和 Spark，洞察只指向会话，问一问通过侧栏切回洞察', async () => {
  const user = userEvent.setup()
  render(<App conversations={[]} />)
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  expect(screen.getByRole('heading', { name: '你的人格倾向' })).toBeVisible()
  expect(screen.getAllByText('尚待了解')).toHaveLength(4)
  expect(screen.getByRole('heading', { name: /Spark/ })).toBeVisible()
  expect(screen.queryByRole('img', { name: /倾向/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  expect(screen.getByText('暂无洞察报告')).toBeVisible()
  expect(screen.getByRole('button', { name: '前往会话' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '问一问' }))
  expect(screen.getByRole('heading', { name: '目前还没有问题哦' })).toBeVisible()
  expect(screen.queryByRole('button', { name: /^返回/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  expect(screen.getByRole('heading', { name: '对话洞察' })).toBeVisible()
})

it('空列表导航到会话，选择会话后由工具栏打开范围，取消保留原聊天', async () => {
  const user = userEvent.setup()
  const adapter: ConversationAiAdapter = { models: [{id:'m',label:'测试模型'}], skills: [], analyze: vi.fn(), respond: vi.fn() }
  render(<App conversations={[{id:'1',title:'老同学',messages:[]},{id:'2',title:'周末同行',messages:[]}]} conversationAiAdapter={adapter} />)
  await user.click(screen.getByRole('button', {name:'对话洞察'}))
  await user.click(await screen.findByRole('button', { name: '前往会话' }))
  await user.click(screen.getByRole('button', {name:/周末同行/}))
  expect(await screen.findByRole('heading', { name: '周末同行' })).toBeVisible()
  expect(screen.queryByRole('region', { name: '会话洞察状态' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '会话洞察' }))
  expect(await screen.findByRole('heading', {name:'会话洞察'})).toBeVisible()
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.getByRole('heading', { name: '周末同行' })).toBeVisible()
  expect(adapter.analyze).not.toHaveBeenCalled()
})

it('一段关系已可判断时显示对应维度的关系数并能阅读来源', async () => {
  const user = userEvent.setup()
  const api = { ai:{ listAnalyses: async () => [insightTask], onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.click(screen.getByRole('button', { name:'个人总览' }))
  const approach = await screen.findByRole('group', { name:'判断 J / 感知 P' })
  await waitFor(() => expect(approach).toHaveTextContent('再有一段关系'))
  expect(approach.querySelector('[role=img]')).toBeNull()
  await user.click(screen.getByRole('button', {name:/在「周末」这段聊天中.*你的倾向.*\?\?\?J/}))
  expect(await screen.findByRole('article')).toHaveTextContent('你们会一起商量。')
})

it('Hello 悬停预览不挂载私人的会话标题或发现内容', async () => {
  const user = userEvent.setup()
  const privateName = '虚构的私密会话名称'
  const api = { ai: {listAnalyses: async () => [{...insightTask, conversationTitle: privateName}], onEvent: () => () => {}} } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.hover(screen.getByRole('button', {name:/进入个人总览/}))
  expect(document.querySelector('.hello-cover-preview')).not.toHaveTextContent(privateName)
  await user.click(screen.getByRole('button', {name:'个人总览'}))
  expect(await screen.findByRole('button', {name:new RegExp(privateName)})).toBeVisible()
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
  await act(async () => loaded([insightTask]))
  expect(await screen.findByRole('button', { name: /在「周末」这段聊天中.*你的倾向/ })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '对话洞察' }))
  expect(listAnalyses).toHaveBeenCalledTimes(1)
})

it('初读与运行进度交错时保留最新版本和删除结果', async () => {
  let listener!: (event: AiEvent) => void
  let loaded!: (tasks: AnalysisTask[]) => void
  const partial: AnalysisTask = { ...insightTask, id: '10', state: 'running', totalMessages: 12, report: undefined }
  const api = { ai: { listAnalyses: () => new Promise<AnalysisTask[]>(resolve => { loaded = resolve }),
    onEvent: (callback: typeof listener) => { listener = callback; return () => {} } } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await userEvent.click(screen.getByRole('button', { name: '对话洞察' }))
  await act(async () => {
    listener({ kind: 'analysis', snapshot: { ...partial, analyzedMessages: 3, eventSequence: 2 } })
    listener({ kind: 'analysis-deleted', taskId: '1', conversationId: '1' })
    loaded([insightTask, { ...partial, analyzedMessages: 8, eventSequence: 5 }])
  })
  expect(screen.getByRole('button', { name: /#10/ }).closest('li')).toHaveTextContent('8 / 12')
  expect(screen.queryByRole('button', { name: /#1\b/ })).toBeNull()
})

it('运行进度更新保留同一会话的置顶和手动排列顺序', async () => {
  let listener!: (event: AiEvent) => void
  const pinned = { ...insightTask, id: '23', pinned: true }
  const first = { ...insightTask, id: '21' }
  const running: AnalysisTask = { ...insightTask, id: '24', state: 'running', totalMessages: 12, report: undefined }
  const last = { ...insightTask, id: '22' }
  const api = { ai: { listAnalyses: async () => [pinned, first, running, last],
    onEvent: (callback: typeof listener) => { listener = callback; return () => {} } } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await userEvent.click(screen.getByRole('button', { name: '对话洞察' }))
  const rows = [
    await screen.findByRole('button', { name: /#23/ }),
    screen.getByRole('button', { name: /#21/ }),
    screen.getByRole('button', { name: /#24/ }),
    screen.getByRole('button', { name: /#22/ }),
  ]
  expect(screen.getAllByRole('button', { name: /#2[1-4]/ })).toEqual(rows)
  await act(async () => listener({ kind: 'analysis', snapshot: { ...running, analyzedMessages: 8, eventSequence: 4 } }))
  expect(screen.getByRole('button', { name: /#24/ }).closest('li')).toHaveTextContent('8 / 12')
  expect(screen.getAllByRole('button', { name: /#2[1-4]/ })).toEqual(rows)
})

it('新任务到达及生成完成后仍排在同会话的置顶报告后面', async () => {
  let listener!: (event: AiEvent) => void
  const pinned = { ...insightTask, id: '23', pinned: true }
  const first = { ...insightTask, id: '21' }
  const last = { ...insightTask, id: '22' }
  const running: AnalysisTask = { ...insightTask, id: '24', state: 'running', totalMessages: 12, report: undefined }
  let stored = [pinned, first, last]
  const api = { ai: { listAnalyses: async () => stored,
    onEvent: (callback: typeof listener) => { listener = callback; return () => {} } } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await userEvent.click(screen.getByRole('button', { name: '对话洞察' }))
  const pinnedRow = await screen.findByRole('button', { name: /#23/ })
  const firstRow = screen.getByRole('button', { name: /#21/ })
  const lastRow = screen.getByRole('button', { name: /#22/ })
  await act(async () => listener({ kind: 'analysis', snapshot: running }))
  expect(screen.getAllByRole('button', { name: /#2[1-4]/ })).toEqual([
    pinnedRow, screen.getByRole('button', { name: /#24/ }), firstRow, lastRow,
  ])
  const completed: AnalysisTask = { ...running, state: 'completed', analyzedMessages: 12, eventSequence: 4, report: insightTask.report }
  stored = [pinned, completed, first, last]
  await act(async () => listener({ kind: 'analysis', snapshot: completed }))
  expect(screen.getAllByRole('button', { name: /#2[1-4]/ })).toEqual([
    pinnedRow, screen.getByRole('button', { name: /#24/ }), firstRow, lastRow,
  ])
  await userEvent.click(screen.getByRole('button', { name: /#24/ }))
  expect(screen.getByRole('article')).toHaveTextContent('你们会一起商量。')
})

it('置顶与取消置顶后的新顺序在后续进度更新中保持生效', async () => {
  const user = userEvent.setup()
  let listener!: (event: AiEvent) => void
  const report = { ...insightTask, id: '23' }
  const running: AnalysisTask = { ...insightTask, id: '24', state: 'running', totalMessages: 12, report: undefined }
  let stored = [running, report]
  const api = { ai: {
    listAnalyses: async () => stored,
    onEvent: (callback: typeof listener) => { listener = callback; return () => {} },
    arrangeAnalysis: async (change: { id: string; pinned: boolean }) => {
      if (change.id !== '23') throw Error('unexpected report')
      const updated = { ...report, pinned: change.pinned, eventSequence: change.pinned ? 4 : 5 }
      stored = change.pinned ? [updated, running] : [running, updated]
    },
  } } as unknown as DesktopApi
  render(<App conversations={[]} preview importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  const reportRow = await screen.findByRole('button', { name: /#23/ })
  const runningRow = screen.getByRole('button', { name: /#24/ })
  expect(screen.getAllByRole('button', { name: /#2[34]/ })).toEqual([runningRow, reportRow])
  await user.pointer({ target: reportRow, keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: /#2[34]/ })).toEqual([reportRow, runningRow]))
  await act(async () => listener({ kind: 'analysis', snapshot: { ...running, analyzedMessages: 8, eventSequence: 4 } }))
  expect(runningRow.closest('li')).toHaveTextContent('8 / 12')
  expect(screen.getAllByRole('button', { name: /#2[34]/ })).toEqual([reportRow, runningRow])
  await user.pointer({ target: reportRow, keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '取消置顶' }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: /#2[34]/ })).toEqual([runningRow, reportRow]))
  await act(async () => listener({ kind: 'analysis', snapshot: { ...running, analyzedMessages: 10, eventSequence: 5 } }))
  expect(runningRow.closest('li')).toHaveTextContent('10 / 12')
  expect(screen.getAllByRole('button', { name: /#2[34]/ })).toEqual([runningRow, reportRow])
})
