import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ConversationReader, resolveSourceRange } from './components/conversations'
import type { Conversation } from './components/conversations'
import type { OverviewData, SourceReference } from './components/overview/types'

const conversations: Conversation[] = [{ id: 'friends', title: '朋友近况', messages: [
  { id: 'before', sender: '朋友', text: '下周答辩，最近有点紧张。' },
  { id: 'start', sender: '我', text: '你想先一起过一遍提纲吗？', isSelf: true },
  { id: 'middle', sender: '朋友', text: '我最担心问答环节。' },
  { id: 'end', sender: '我', text: '周三晚上我有空，我们试着练一遍。', isSelf: true },
  { id: 'after', sender: '朋友', text: '好，周三见。' },
] }]
const source: SourceReference = { id: 'source', conversationId: 'friends', messageId: 'start', endMessageId: 'end', title: '答辩前的准备', context: '朋友谈到答辩中的困难，你讨论了具体准备办法。' }
const overview: OverviewData = { materialStatus: 'ready', discoveries: [{ id: 'spark', title: '你会把关心放进具体安排里', observation: '这段交流里，你通过一起准备来回应朋友的担忧。', scenes: [{ title: '朋友准备答辩', context: '朋友在答辩前一周感到紧张。', interaction: '对方说出担心问答后，你们商量了练习时间。', behavior: '你主动提出过提纲，并约好周三练习。', sourceIds: ['source'] }], sources: [source] }] }

beforeEach(() => {
  const media = window.matchMedia('')
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, media: query, matches: query === '(prefers-reduced-motion: reduce)' }))
})

describe('总览导航与原文范围', () => {
  it('独立解惑菜单进入诚实空状态，总览内没有解惑入口', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))
    expect(within(screen.getByRole('main')).queryByRole('button', { name: '解惑' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '解惑' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '解惑' })).toHaveFocus())
    expect(screen.getByText('疑问今天请假了。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解惑' })).toHaveAttribute('aria-current', 'page')
  })

  it('定位一段交流并保留前后文，返回总览保留未提交草稿', async () => {
    const user = userEvent.setup()
    render(<App conversations={conversations} overview={overview} />)
    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))
    await user.click(screen.getByRole('button', { name: '说说看法' }))
    const field = screen.getByRole('textbox')
    await user.type(field, '这只发生在熟悉的朋友之间。')
    await user.click(screen.getByRole('button', { name: /答辩前的准备/ }))
    const reader = screen.getByRole('region', { name: '聊天记录' })
    expect(within(reader).getByText('下周答辩，最近有点紧张。')).toBeInTheDocument()
    expect(within(reader).getByText('好，周三见。')).toBeInTheDocument()
    expect(reader.querySelectorAll('.message-source')).toHaveLength(3)
    await waitFor(() => expect(within(reader).getByText('你想先一起过一遍提纲吗？').closest('li')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: '返回个人总览' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '个人总览' })).toHaveFocus())
    expect(screen.getByRole('textbox')).toHaveValue('这只发生在熟悉的朋友之间。')
    await user.click(screen.getByRole('link', { name: 'Whomi 首页' }))
    expect(screen.queryByText('你会把关心放进具体安排里')).not.toBeInTheDocument()
  })

  it('只有实际存在且顺序正确的完整范围可跳转', () => {
    expect(resolveSourceRange(conversations, source)).toMatchObject({ startIndex: 1, endIndex: 3 })
    expect(resolveSourceRange(conversations, { ...source, conversationId: 'gone' })).toBeNull()
    expect(resolveSourceRange(conversations, { ...source, messageId: 'gone' })).toBeNull()
    expect(resolveSourceRange(conversations, { ...source, endMessageId: 'gone' })).toBeNull()
    expect(resolveSourceRange(conversations, { ...source, messageId: 'end', endMessageId: 'start' })).toBeNull()
    expect(resolveSourceRange(conversations, { ...source, unavailable: true })).toBeNull()
  })

  it('阅读器收到失效范围时不标记错误消息，并提供查找提示', () => {
    render(<ConversationReader conversation={conversations[0]} sourceRange={{ messageId: 'gone' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('无法定位原文，请在这段会话中查找。')
    expect(screen.getByRole('region', { name: '聊天记录' }).querySelector('.message-source')).toBeNull()
  })

  it('窄屏键盘进入解惑后收起导航面板，并聚焦页面标题', async () => {
    const media = window.matchMedia('')
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, media: query, matches: query === '(prefers-reduced-motion: reduce)' || query === '(max-width: 640px)' }))
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    screen.getByRole('button', { name: '解惑' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: '导航面板' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: '解惑' })).toHaveFocus())
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
  })

  it('打开没有结果的总览不调用模型或反馈保存', async () => {
    const fetch = vi.spyOn(window, 'fetch')
    const save = vi.fn()
    const user = userEvent.setup()
    render(<App saveFeedback={save} />)
    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))
    expect(screen.getByText('还没有可查看的总览。')).toBeInTheDocument()
    expect(screen.queryByText('E?F?')).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
