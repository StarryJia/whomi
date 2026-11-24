import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import App from '../../App'
import type { AiEvent, AnalysisTask } from '../../shared/ai-contract'
import { judgmentCitation, type InsightJudgment, type InsightReport } from '../../shared/conversation-insights'
import type { DesktopApi } from '../../shared/desktop-api'
import { ConversationWorkspace } from '../conversation-ai/workspace'
import type { ConversationAiAdapter } from '../conversation-ai/types'
import { ConversationReader } from '../conversations'
import { InsightArticle } from './insight-article'
import { InsightsLibrary } from './insights-library'
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

it('从任务行任意内容打开指定任务，详情和任务控制按钮单独操作', async () => {
  const user = userEvent.setup()
  const onTask = vi.fn()
  const onStop = vi.fn(async () => {})
  const onContinue = vi.fn(async () => {})
  const { report: _report, ...base } = completed
  const running: AnalysisTask = { ...base, state: 'running', analyzedMessages: 6, elapsedMs: 2500, modelId: '示例模型' }
  render(<InsightsLibrary tasks={[running, { ...running, id: '25', state: 'stopped' }, { ...running, id: '26', state: 'failed' }]}
    conversations={[]} loading={false} error="" retry={() => {}} onSelect={() => {}} onReturn={() => {}}
    onTask={onTask} onStop={onStop} onContinue={onContinue} onConversations={() => {}} onRenameBusy={() => {}} />)
  const [runningRow, pausedRow, failedRow] = screen.getAllByRole('listitem')
  const row = within(runningRow)
  const title = row.getByRole('button', { name: /会话洞察 #24/ })
  for (const target of [title, row.getByRole('status'), row.getByText(/已运行 00:02/), row.getByText('示例模型'), runningRow]) {
    await user.click(target)
    expect(onTask).toHaveBeenLastCalledWith('1', '24')
  }
  expect(onTask).toHaveBeenCalledTimes(5)

  title.focus()
  await user.keyboard('{Enter}')
  expect(onTask).toHaveBeenCalledTimes(6)
  await user.tab()
  expect(row.getByRole('button', { name: '暂停' })).toHaveFocus()
  await user.keyboard(' ')
  expect(onStop).toHaveBeenCalledExactlyOnceWith('24')
  await user.click(row.getByRole('button', { name: '详情' }))
  expect(row.getByRole('group', { name: '分析用量' })).toBeVisible()
  await user.click(within(pausedRow).getByRole('button', { name: '继续洞察' }))
  await user.click(within(failedRow).getByRole('button', { name: '重试' }))
  expect(onContinue.mock.calls).toEqual([['25'], ['26']])
  expect(onTask).toHaveBeenCalledTimes(6)
  await user.click(within(pausedRow).getByRole('status'))
  expect(onTask).toHaveBeenLastCalledWith('1', '25')
})

it('任务请求等待时运行时间递增，失败后保留同口径的覆盖和冻结时间', () => {
  vi.useFakeTimers()
  try {
    const running: AnalysisTask = { ...completed, report: undefined, state: 'running',
      analyzedMessages: 6, elapsedMs: 3000, elapsedSampledAtMs: Date.now() }
    const library = (task: AnalysisTask) => <InsightsLibrary tasks={[task]} conversations={[]} loading={false} error=""
      retry={() => {}} onSelect={() => {}} onReturn={() => {}} onTask={() => {}} onConversations={() => {}} onRenameBusy={() => {}} />
    const { rerender } = render(library(running))
    expect(screen.getByText('已运行 00:03 · 2 消息数/s')).toBeVisible()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('已运行 00:06 · 1 消息数/s')).toBeVisible()
    rerender(library({ ...running, state: 'failed', elapsedMs: 6000, elapsedSampledAtMs: undefined }))
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByRole('status')).toHaveTextContent('生成失败')
    expect(screen.getByText(/6 \/ 12 条/)).toBeVisible()
    expect(screen.getByText(/已运行 00:06 · 1 消息数\/s/)).toBeVisible()
  } finally {
    vi.useRealTimers()
  }
})

it('报告只有材料不足说明时保留模型的限定并沿用两节阅读结构', () => {
  render(<InsightArticle report={{ ...report, aboutYou: [], relationship: [], limitations: ['只有一次改期，暂时不能判断相处习惯。'] }} />)
  expect(screen.getByText('只有一次改期，暂时不能判断相处习惯。')).toBeVisible()
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['关于你', '你们的相处'])
})

it('先读本次四维预测，再从判断正文里的原话打开对应依据或反例', async () => {
  const user = userEvent.setup()
  const unknown: InsightJudgment = { dimension: 'EI', direction: null, text: '这段对话只谈了见面时间。',
    supportingSources: [], counterexampleSources: [], alternativeExplanations: [], limitations: [] }
  const observed: InsightJudgment = { dimension: 'JP', direction: 'J', text: '你先说「我来订票」，还提议「先看早场」，又问「在哪一站集合」。',
    supportingSources: [{ messageId: '20', revision: 'r20', excerpts: ['我来订票', '先看早场'] }, { messageId: '21', revision: 'r21', excerpts: ['在哪一站集合'] }],
    counterexampleSources: [{ messageId: '28', revision: 'r28', excerpts: ['到时再定'] }],
    alternativeExplanations: ['你这次负责订票。'], limitations: ['只涉及这次见面。'] }
  const saved: InsightReport = { ...report, judgments: [observed, unknown] }
  const readInsightCitation = vi.fn(async () => ({ status: 'expired' }))
  const api = { ai: { listAnalyses: async () => [{ ...completed, report: saved }], getReport: async () => saved, readInsightCitation, onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  await user.click(await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ }))
  const region = screen.getByRole('region', { name: 'MBTI 人格倾向' })
  const article = within(screen.getByRole('article'))
  expect(region).toHaveTextContent('???J')
  expect(region).not.toHaveTextContent('暂难判断')
  expect(region.compareDocumentPosition(article.getByRole('heading', { name: '关于你' }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(article.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['关于你', '你们的相处'])
  expect(article.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['精力来源 · 暂难判断', '安排方式 · 偏向判断'])
  expect(article.getByText('你这次负责订票。', { exact: false })).toBeVisible()
  expect(article.getByText('只涉及这次见面。', { exact: false })).toBeVisible()
  for (const [kind, fragmentIndex, quote] of [
    ['supporting', 1, '在哪一站集合'], ['counterexample', 0, '到时再定'], ['supporting', 0, '先看早场'], ['supporting', 0, '我来订票'],
  ] as const) {
    const button = await article.findByRole('button', { name: new RegExp(quote) })
    expect(button.closest('p')).not.toBeNull()
    await user.click(button)
    expect(readInsightCitation).toHaveBeenLastCalledWith({ taskId: '24', fragmentIndex, citationId: judgmentCitation(saved, '1', 0, kind)!.id })
    expect(screen.getByRole('dialog')).toHaveTextContent(quote)
    await user.click(screen.getByRole('button', { name: '关闭原文' }))
    expect(button).toHaveFocus()
  }
})

it('旧报告同一维度的相反观察都可阅读，不合成单一倾向', () => {
  const original: InsightJudgment = { dimension: 'TF', direction: 'T', text: '你先比较了时间成本。',
    supportingSources: [{ messageId: '10', revision: 'source-10' }], counterexampleSources: [], alternativeExplanations: [], limitations: [] }
  render(<InsightArticle report={{ ...report, judgments: [original, { ...original, direction: 'F', text: '你先问了对方是否愿意。' }] }} />)
  const article = within(screen.getByRole('article'))
  expect(article.getByRole('heading', { level: 3, name: '做决定 · 暂难判断' })).toBeVisible()
  expect(article.getByText('偏向思考。')).toBeVisible()
  expect(article.getByText('偏向情感。')).toBeVisible()
  expect(article.getByRole('region', { name: 'MBTI 人格倾向' })).toHaveTextContent('????')
})

it('分析中长短摘录重叠时保留各自的引语位置，无法摘出短句的有效来源仍可打开', async () => {
  const onOpenCitation = vi.fn()
  const text = '一起约是话题。你先说「周三一起约」，对方又说「一起约」。'
  const saved: InsightReport = { ...report, judgments: [{ dimension: 'EI', direction: null, text,
    supportingSources: [{ messageId: '11', revision: 'a', excerpts: ['周三一起约'] }],
    counterexampleSources: [{ messageId: '12', revision: 'b', excerpts: ['一起约'] }, { messageId: '13', revision: 'c', excerpts: [] }],
    alternativeExplanations: [], limitations: [] }] }
  render(<InsightArticle report={saved} conversationId="1" onOpenCitation={onOpenCitation} />)
  const short = screen.getByRole('button', { name: '一起约' })
  expect(short.previousSibling?.textContent).toBe('」，对方又说「')
  const source = screen.getByRole('button', { name: /消息/ })
  await userEvent.click(source)
  expect(onOpenCitation).toHaveBeenLastCalledWith(judgmentCitation(saved, '1', 0, 'counterexample'), source, 1)
})

it('正文逐字引文直接定位已核对的片段，历史摘要仍按原有片段顺序打开', async () => {
  const onOpenCitation = vi.fn()
  const reference = { ...report.citations[0], fragments: [...report.citations[0].fragments,
    { sources: [{ messageId: '13', revision: 'r13' }, { messageId: '14', revision: 'r14' }] }] }
  const saved = { ...report, citations: [reference], relationship: [{ content: [
    { text: '周三见', citationId: reference.id, quoteFragmentIndex: 1, quoteMessageId: '14' },
    { text: '我再查查', citationId: reference.id, quoteFragmentIndex: 1 },
  ] }] }
  const { rerender } = render(<InsightArticle report={saved} citationsLoading conversationId="1" onOpenCitation={onOpenCitation} />)
  const quote = screen.getByRole('button', { name: '周三见' })
  expect(quote).toBeDisabled()
  await userEvent.click(quote)
  expect(onOpenCitation).not.toHaveBeenCalled()
  rerender(<InsightArticle report={saved} conversationId="1" onOpenCitation={onOpenCitation} />)
  await userEvent.click(quote)
  expect(onOpenCitation).toHaveBeenLastCalledWith(reference, quote, 1, '周三见', '14')
  const oldQuote = screen.getByRole('button', { name: '我再查查' })
  await userEvent.click(oldQuote)
  expect(onOpenCitation).toHaveBeenLastCalledWith(reference, oldQuote, 1, '我再查查', undefined)
  const summary = screen.getByRole('button', { name: '那次改期' })
  await userEvent.click(summary)
  expect(onOpenCitation).toHaveBeenLastCalledWith(reference, summary)
})

it.each([
  ['找不到来源', []],
  ['片段为空', [{ ...report.citations[0], fragments: [] }]],
  ['来源属于其他会话', [{ ...report.citations[0], conversationId: '2' }]],
] as const)('报告中的引用%s时提示无法定位，保留报告且不读取聊天', async (_reason, citations) => {
  const user = userEvent.setup()
  const readInsightCitation = vi.fn()
  const api = { ai: {
    listAnalyses: async () => [{ ...completed, report: { ...report, citations } }],
    readInsightCitation, onEvent: () => () => {},
  } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  await user.click(await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ }))
  expect(screen.queryByRole('button', { name: '你和 ta 一起核对了时间。' })).toBeNull()
  const citation = screen.getByRole('button', { name: '那次改期' })
  expect(citation).not.toHaveAttribute('aria-haspopup')
  await user.click(citation)
  expect(screen.getByRole('alert')).toHaveTextContent('无法定位这处引用的原文')
  await user.click(screen.getByRole('button', { name: '关闭提醒' }))
  expect(citation).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('alert')).toHaveTextContent('无法定位这处引用的原文')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(readInsightCitation).not.toHaveBeenCalled()
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
  expect(screen.queryByRole('button', { name: /新建报告|开始洞察/ })).toBeNull()
  await user.click(row)
  expect(screen.getByRole('heading', { name: '会话洞察', level: 1 })).toBeVisible()
  expect(screen.getByRole('heading', { name: '关于你' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '你们的相处' })).toBeVisible()
  expect(screen.getByText('2026.10.03—2026.10.03')).toBeVisible()
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

it.each([
  { scope: completed.scope, timezone: 'Asia/Shanghai', hour: 16 },
  { scope: { kind: 'all' } as const, timezone: 'Pacific/Kiritimati', hour: 10 },
])('按报告冻结的时区展示实际首末消息日期 ($timezone)', async ({ scope, timezone, hour }) => {
  const user = userEvent.setup()
  const reportWithTwoDays = {
    ...completed, scope, timezone,
    sourceStartTimeMs: Date.UTC(2026, 9, 2, hour, 30),
    sourceEndTimeMs: Date.UTC(2026, 9, 3, hour, 30),
  }
  const api = { ai: { listAnalyses: async () => [reportWithTwoDays], onEvent: () => () => {} } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  const row = await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ })
  expect(row).toHaveTextContent('对话范围 2026.10.03—2026.10.04')
  await user.click(row)
  expect(screen.getByText('2026.10.03—2026.10.04')).toBeVisible()
})

it('打开短报告再返回时恢复列表原有滚动位置、分组和行焦点', async () => {
  const user = userEvent.setup()
  const api = { ai: {
    listAnalyses: async () => [completed, { ...completed, id: '25', conversationId: '2', conversationTitle: '小陈' }],
    onEvent: () => () => {},
  } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  const row = await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ })
  const group = screen.getByRole('button', { name: '小陈（1）' })
  await user.click(group)
  const main = screen.getByRole('main')
  const list = row.closest('.insights-list')!
  let scrollTop = 420
  Object.defineProperty(main, 'scrollTop', {
    // 短报告替换长列表时，浏览器把滚动位置限制为 0。
    get: () => list.hasAttribute('hidden') ? 0 : scrollTop,
    set: (value: number) => { scrollTop = value },
  })

  await user.click(row)
  expect(main.scrollTop).toBe(0)
  await user.click(screen.getByRole('button', { name: '返回' }))
  expect(main.scrollTop).toBe(420)
  expect(group).toHaveAttribute('aria-expanded', 'false')
  expect(row).toHaveFocus()
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

it('读取或保存本人失败时保留选择，成功后需再次点击洞察才显示范围', async () => {
  const user = userEvent.setup()
  const adapter = { ...baseAdapter, analyze: vi.fn() }
  const listMembers = vi.fn(async () => [{ id: '1', displayName: '小周', accountId: null, confirmedSelf: false, selfHint: true }])
    .mockRejectedValueOnce({ action: '重新读取成员。' })
  const confirmSelf = vi.fn(async () => undefined).mockRejectedValueOnce({ action: '重新保存本人。' })
  render(<ConversationReader conversation={{ id: '1', title: '小林', messages: [] }} messageCount={12}
    aiAdapter={adapter} api={{ listMembers, confirmSelf } as unknown as DesktopApi} />)
  await user.click(await screen.findByRole('button', { name: '取消' }))
  const entry = screen.getByRole('button', { name: '会话洞察' })
  await user.click(entry)
  expect(screen.getByRole('dialog')).toHaveTextContent('请先选择本人，再开始会话洞察。')
  expect(screen.queryByRole('button', { name: '开始洞察' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '重新读取成员' }))
  expect(await screen.findByText('来源推测')).toBeVisible()
  expect(screen.getByRole('button', { name: '设为本人' })).toBeDisabled()
  await user.click(await screen.findByRole('radio', { name: /小周/ }))
  expect(screen.queryByRole('button', { name: '开始洞察' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '设为本人' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('重新保存本人')
  expect(screen.getByRole('radio', { name: /小周/ })).toBeChecked()
  expect(screen.queryByRole('button', { name: '开始洞察' })).toBeNull()
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
  expect(dialog).toHaveTextContent('对话范围：2026.10.03—2026.10.03')
  await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
  expect(deleteAnalysis).toHaveBeenCalledWith('24')
  await act(async () => publish({ kind: 'analysis', snapshot: { ...completed, eventSequence: 30 } }))
  await act(async () => resolveList([completed, { ...completed, id: '23' }]))
  expect(screen.queryByRole('button', { name: /小林.*会话洞察.*#24/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /小林.*会话洞察.*#23/ })).toBeVisible()
})

it.each(['报告', '会话'])('原文读取期间删除%s后退出到列表，不向已删除的引用交还焦点', async target => {
  const user = userEvent.setup()
  let publish!: (event: AiEvent) => void
  let conversationDeleted!: (id: string) => void
  let release!: () => void
  const api = {
    onConversationDeleted: (listener: typeof conversationDeleted) => { conversationDeleted = listener; return () => {} },
    ai: {
      listAnalyses: async () => [completed, { ...completed, id: '23' }],
      readInsightCitation: async () => {
        await new Promise<void>(resolve => { release = resolve })
        return { status: 'unavailable' }
      },
      onEvent: (listener: typeof publish) => { publish = listener; return () => {} },
    },
  } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  await user.click(await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ }))
  const citation = screen.getByRole('button', { name: '那次改期' })
  await user.click(citation)
  const dialog = screen.getByRole('dialog')
  within(dialog).getByRole('button', { name: '关闭原文' }).focus()
  const restored = vi.fn()
  citation.addEventListener('focus', restored)
  await act(async () => {
    if (target === '报告') publish({ kind: 'analysis-deleted', taskId: '24', conversationId: '1' })
    else conversationDeleted('1')
  })
  await act(async () => release())
  expect(restored).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('heading', { name: '对话洞察' })).toHaveFocus()
  if (target === '报告') expect(screen.getByRole('button', { name: /小林.*会话洞察.*#23/ })).toBeVisible()
  else expect(screen.getByRole('heading', { name: '暂无洞察报告' })).toBeVisible()
})

it.each(['下一行', '页面标题'])('删除通知先于请求回执时聚焦%s，跳过同时移除的相邻报告', async target => {
  const user = userEvent.setup()
  let publish!: (event: AiEvent) => void
  let finishDelete!: () => void
  const deleteAnalysis = vi.fn(() => new Promise<void>(resolve => { finishDelete = resolve }))
  const candidates = [completed, { ...completed, id: '23' }]
  if (target === '下一行') candidates.push({ ...completed, id: '22' })
  const api = { ai: {
    listAnalyses: async () => candidates, deleteAnalysis,
    onEvent: (listener: typeof publish) => { publish = listener; return () => {} },
  } } as unknown as DesktopApi
  render(<App preview conversations={[]} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  fireEvent.contextMenu(await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ }))
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
  expect(deleteAnalysis).toHaveBeenCalledExactlyOnceWith('24')

  await act(async () => {
    for (const taskId of ['23', '24']) publish({ kind: 'analysis-deleted', taskId, conversationId: '1' })
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  const destination = target === '下一行'
    ? screen.getByRole('button', { name: /小林.*会话洞察.*#22/ })
    : screen.getByRole('heading', { name: '对话洞察' })
  expect(destination).toHaveFocus()
  await act(async () => finishDelete())
  expect(destination).toHaveFocus()
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
  expect(screen.getByText('缓存写入').nextElementSibling).toHaveTextContent('0 token')
  expect(screen.getByText('缓存读取').nextElementSibling).toHaveTextContent('—')
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
