import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFixtureDrafts, composerTextbox, expectComposerText, pasteComposerText } from '../../test/cherry-composer-helpers'
import { ConversationReader } from '../conversations'
import { createPreviewClient } from '../../data/preview-client'
import type { ConversationAiAdapter, RestoredConversationTurn } from './types'

beforeEach(() => clearFixtureDrafts('c', ['A', 'B', 'new']))

const threads = ['A', 'B'].map(id => ({ id, conversationId: 'c', title: `对话 ${id}`, createdAtMs: 1, updatedAtMs: 1 }))
const turn = (id: string): RestoredConversationTurn => ({
  id: `turn-${id}`, requestId: `request-${id}`, prompt: `问题 ${id}`, referenceIds: [id === 'A' ? '1' : '2'],
  modelId: 'm', text: `回答 ${id}`, state: 'completed',
})
function adapter(): ConversationAiAdapter {
  return {
    models: [{ id: 'm', label: '示例模型' }], skills: [],
    listThreads: async () => threads,
    restoreThread: async (_conversationId, threadId) => threadId === 'new' ? [] : [turn(threadId ?? 'A')],
    createThread: async () => ({ id: 'new', conversationId: 'c', title: '新对话', createdAtMs: 2, updatedAtMs: 2, turns: [] }),
    deleteThread: async () => {}, respond: vi.fn(async () => ({ text: '新回答' })), analyze: async () => {},
  }
}
async function conversation() {
  const client = createPreviewClient([{ id: 'c', title: '生命周期虚构会话', messages: [
    { id: '1', sender: '甲', text: '第一条原文' },
    { id: '2', sender: '乙', text: '第二条原文' },
  ] }])
  return { id: 'c', title: '生命周期虚构会话', messages: (await client.readMessages({ conversationId: 'c', direction: 'after' })).items }
}
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await visibleAnswer('回答 A')
}
async function switchToB(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '显示对话列表' }))
  await user.click(screen.getByRole('button', { name: '对话 B' }))
  await visibleAnswer('回答 B')
}
async function visibleAnswer(text: string) {
  await waitFor(() => expect(screen.getByText(text)).toBeVisible())
}
async function viewSentReference(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await within(screen.getByRole('log')).findByRole('button', { name: '1 条引用' }))
}
const marked = () => document.querySelectorAll('.message-reference-target')

describe('AI 对话结束与切换边界', () => {
  it('新建操作复用当前空对话时结束引用查看，保留草稿与待发送引用', async () => {
    const user = userEvent.setup(), client = adapter()
    client.listThreads = async () => [threads[0]]
    client.restoreThread = async () => []
    client.createThread = vi.fn(client.createThread)
    render(<ConversationReader conversation={await conversation()} aiAdapter={client} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    const newThread = screen.getByRole('button', { name: '新建 AI 对话' })
    await waitFor(() => expect(newThread).toBeEnabled())
    await pasteComposerText('保留这个问题')
    const draft = await composerTextbox()
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('option', { name: '甲：第一条原文' }))
    await user.click(screen.getByRole('button', { name: '1 组引用' }))
    await user.click(screen.getByRole('button', { name: /引用 1 · 甲/ }))
    expect(marked()).toHaveLength(1)

    await user.click(newThread)

    expect(marked()).toHaveLength(0)
    expect(client.createThread).not.toHaveBeenCalled()
    await expectComposerText('保留这个问题')
    expect(screen.getByRole('button', { name: '1 组引用' })).toBeVisible()
    await waitFor(() => expect(draft).toHaveFocus())
  })

  it('开始另一处引用定位即清除旧标记，失败后只保留新定位的重试入口', async () => {
    const user = userEvent.setup(), client = adapter(), full = await conversation()
    client.listThreads = async () => [threads[0]]
    client.restoreThread = async () => [turn('A'), turn('B')]
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finish = resolve })
    const locate = vi.fn(() => pending)
    const reader = (messages: typeof full.messages) => <ConversationReader conversation={{ ...full, messages }}
      aiAdapter={client} onLocateMessageId={locate} />
    const view = render(reader(full.messages.slice(0, 1)))
    await openPanel(user)
    const [first, second] = await waitFor(() => {
      const refs = within(screen.getByRole('log')).getAllByRole('button', { name: '1 条引用' })
      expect(refs).toHaveLength(2)
      return refs
    })
    await user.click(first)
    expect(Array.from(marked(), element => element.getAttribute('data-message-id'))).toEqual(['1'])

    await user.click(second)
    expect(marked()).toHaveLength(0)
    await act(async () => { finish(false); await pending })
    expect(marked()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '重试定位' })).toBeVisible()

    locate.mockImplementation(async () => { view.rerender(reader(full.messages)); return true })
    await user.click(screen.getByRole('button', { name: '重试定位' }))
    expect(locate).toHaveBeenLastCalledWith('2')
    expect(Array.from(marked(), element => element.getAttribute('data-message-id'))).toEqual(['2'])
    expect(screen.queryByRole('button', { name: '重试定位' })).not.toBeInTheDocument()
  })

  it.each(['切换', '新建', '删除当前'] as const)('%s对话时结束原对话的引用定位', async action => {
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} aiAdapter={adapter()} />)
    await openPanel(user)
    await viewSentReference(user)
    expect(marked()).toHaveLength(1)
    if (action === '切换') await switchToB(user)
    else if (action === '新建') {
      await user.click(screen.getByRole('button', { name: '新建 AI 对话' }))
      await waitFor(() => expect(screen.queryByText('回答 A')).not.toBeInTheDocument())
    } else {
      await user.click(screen.getByRole('button', { name: '显示对话列表' }))
      fireEvent.contextMenu(screen.getByRole('button', { name: '对话 A' }), { button: 2, clientX: 40, clientY: 80 })
      await user.click(screen.getByRole('menuitem', { name: '删除' }))
      await user.click(screen.getByRole('button', { name: '确认删除' }))
      await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'AI 对话列表' }))
        .queryByRole('button', { name: '对话 A' })).not.toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: '收起对话列表' }))
      await visibleAnswer('回答 B')
    }
    expect(marked()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '重试定位' })).not.toBeInTheDocument()
  })

  it.each([true, false])('切换对话后不接受旧引用定位的迟到回执（成功：%s）', async succeeds => {
    const user = userEvent.setup(), client = adapter(), full = await conversation()
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finish = resolve })
    const locate = async () => {
      const result = await pending
      if (result) view.rerender(reader(full.messages))
      return result
    }
    const reader = (messages: typeof full.messages) => <ConversationReader conversation={{ ...full, messages }} aiAdapter={client} onLocateMessageId={locate} />
    const view = render(reader(full.messages.slice(1)))
    await openPanel(user)
    await viewSentReference(user)
    await switchToB(user)
    await act(async () => { finish(succeeds); await pending })
    expect(marked()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '重试定位' })).not.toBeInTheDocument()
    expect(screen.getByText('回答 B')).toBeVisible()
  })

  it.each(['清空', '取消选择'] as const)('%s引用后重新选择同一条消息不会恢复已结束的引用描边', async action => {
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} aiAdapter={adapter()} />)
    await openPanel(user)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    const first = () => screen.getByRole('option', { name: '甲：第一条原文' })
    await user.click(first())
    await user.click(screen.getByRole('button', { name: '1 组引用' }))
    await user.click(screen.getByRole('button', { name: /引用 1 · 甲/ }))
    expect(marked()).toHaveLength(1)
    if (action === '清空') {
      await user.click(screen.getByRole('button', { name: '清空全部引用' }))
      expect(marked()).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: '选择消息' }))
    } else {
      await user.click(screen.getByRole('button', { name: '选择消息' }))
      await user.click(first())
    }
    expect(marked()).toHaveLength(0)
    await user.click(first())
    expect(first()).toHaveAttribute('aria-selected', 'true')
    expect(marked()).toHaveLength(0)
  })

  it.each([true, false])('移除待发送引用后不恢复在途定位的结果或重试入口（成功：%s）', async succeeds => {
    const user = userEvent.setup(), client = adapter(), full = await conversation()
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finish = resolve })
    const reader = (messages: typeof full.messages) => <ConversationReader conversation={{ ...full, messages }} aiAdapter={client}
      onLocateMessageId={() => pending} />
    const view = render(reader(full.messages))
    await openPanel(user)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('option', { name: '甲：第一条原文' }))
    view.rerender(reader(full.messages.slice(1)))
    await user.click(screen.getByRole('button', { name: '1 组引用' }))
    await user.click(screen.getByRole('button', { name: /引用 1 · 甲/ }))
    await user.click(screen.getByRole('button', { name: '清空全部引用' }))
    await act(async () => { finish(succeeds); await pending })
    view.rerender(reader(full.messages))
    expect(marked()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '重试定位' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('option', { name: '甲：第一条原文' }))
    expect(marked()).toHaveLength(0)
  })

  it('移除部分待发送引用后只保留有效描边，返回选择后结束所有描边', async () => {
    const user = userEvent.setup()
    const full = await conversation()
    full.messages.push({ ...full.messages[1], id: '3', text: '第三条原文' })
    render(<ConversationReader conversation={full} aiAdapter={adapter()} />)
    await openPanel(user)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('option', { name: '甲：第一条原文' }))
    const third = () => screen.getByRole('option', { name: '乙：第三条原文' })
    await user.click(third())
    await user.click(screen.getByRole('button', { name: '2 组引用' }))
    await user.click(screen.getByRole('button', { name: /引用 1 · 甲/ }))
    expect(marked()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '2 组引用' }))
    await user.click(screen.getByRole('button', { name: '移除第 2 组引用' }))
    expect(Array.from(marked(), element => element.getAttribute('data-message-id'))).toEqual(['1'])
    expect(document.querySelectorAll('.message-selected')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    expect(marked()).toHaveLength(0)
    await user.click(third())
    expect(third()).toHaveAttribute('aria-selected', 'true')
    expect(marked()).toHaveLength(0)
  })

  it('窄窗口查看引用自动收起面板后仍保留本次原文定位', async () => {
    const media = window.matchMedia('')
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, media: query, matches: query === '(max-width: 1000px)' }))
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} aiAdapter={adapter()} />)
    await openPanel(user)
    await viewSentReference(user)
    expect(screen.queryByRole('complementary', { name: 'AI 对话' })).not.toBeInTheDocument()
    expect(marked()).toHaveLength(1)
  })

  it('键盘打开对话列表时关闭待发送引用预览，返回后保留引用和草稿', async () => {
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} aiAdapter={adapter()} />)
    await openPanel(user)
    await pasteComposerText('尚未发送的问题')
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('option', { name: '甲：第一条原文' }))
    await user.click(screen.getByRole('button', { name: '1 组引用' }))
    expect(screen.getByRole('region', { name: '引用预览' })).toBeVisible()
    const history = screen.getByRole('button', { name: '显示对话列表' })
    for (let step = 0; step < 12 && document.activeElement !== history; step += 1) await user.tab({ shift: true })
    expect(history).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('navigation', { name: 'AI 对话列表' })).toBeVisible()
    expect(screen.queryByRole('region', { name: '引用预览' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起对话列表' }))
    expect(screen.getByRole('button', { name: '1 组引用' })).toHaveAttribute('aria-expanded', 'false')
    await expectComposerText('尚未发送的问题')
  })

  it.each([false, true])('切换对话后不接受原对话的停止失败（再次返回原对话：%s）', async returnToA => {
    const user = userEvent.setup(), client = adapter()
    let fail!: (reason: Error) => void
    client.stopTurn = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    client.watchThread = async (_conversationId, receive, _signal, threadId) => {
      receive([{ ...turn(threadId ?? 'A'), state: threadId === 'A' ? 'running' : 'completed' }])
    }
    render(<ConversationReader conversation={await conversation()} aiAdapter={client} />)
    await openPanel(user)
    await user.click(screen.getByRole('button', { name: '停止回答' }))
    await switchToB(user)
    if (returnToA) {
      await user.click(screen.getByRole('button', { name: '显示对话列表' }))
      await user.click(screen.getByRole('button', { name: '对话 A' }))
      await visibleAnswer('回答 A')
    }
    await act(async () => { fail(new Error('停止 A 失败，请重试。')) })
    await visibleAnswer(returnToA ? '回答 A' : '回答 B')
    expect(screen.queryByText('停止 A 失败，请重试。')).not.toBeInTheDocument()
  })

  it('首次发送等待创建对话时关闭面板，创建完成继续发送但不重新打开面板', async () => {
    const user = userEvent.setup(), client = adapter()
    client.listThreads = async () => []
    let finish!: (value: Awaited<ReturnType<NonNullable<ConversationAiAdapter['createThread']>>>) => void
    client.createThread = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<ConversationAiAdapter['createThread']>>>>(resolve => { finish = resolve }))
    render(<ConversationReader conversation={await conversation()} aiAdapter={client} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await pasteComposerText('第一条问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await user.click(screen.getByRole('button', { name: '关闭 AI 对话' }))
    await act(async () => { finish({ id: 'new', conversationId: 'c', title: '新对话', createdAtMs: 2, updatedAtMs: 2, turns: [] }) })
    await waitFor(() => expect(client.respond).toHaveBeenCalledOnce())
    expect(screen.queryByRole('complementary', { name: 'AI 对话' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    expect(await screen.findByText('新回答')).toBeVisible()
  })
})
