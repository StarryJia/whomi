import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationWorkspace } from './workspace'
import type { ConversationAiAdapter } from './types'
import type { AiThread } from '../../shared/ai-contract'
import App from '../../App'
import { createPreviewClient } from '../../data/preview-client'

function Fixture({ adapter }: { adapter: ConversationAiAdapter }) {
  return <ConversationWorkspace conversationId="c" title="示例原始聊天" references={[]} onClearReferences={() => {}} onJumpReference={() => {}} adapter={adapter}>
    {({ analysisControl, chatControl, composer }) => <section aria-label="原文"><header>{analysisControl}{chatControl}</header>{composer}</section>}
  </ConversationWorkspace>
}
function client(): ConversationAiAdapter {
  return { models: [{ id: 'm', label: '示例模型' }], skills: [], respond: vi.fn(async () => ({ text: '回答' })), analyze: async () => {} }
}

describe('会话工作区的明确入口和独立对话', () => {
  it('窄窗历史列表可以单独退出，不遮住可继续操作的输入框', async () => {
    const media = window.matchMedia('')
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, media: query, matches: query === '(max-width: 1000px)' }))
    const user = userEvent.setup()
    render(<Fixture adapter={client()} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.click(screen.getByRole('button', { name: '显示对话列表' }))
    expect(document.querySelector('.conversation-thread-content')).toHaveAttribute('inert')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('navigation', { name: 'AI 对话列表' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'AI 对话' })).toBeVisible()
    expect(document.querySelector('.conversation-thread-content')).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: '显示对话列表' })).toHaveFocus()
    vi.restoreAllMocks()
  })

  it('首次创建对话较慢时，先交接已发送文字，回执不会覆盖后来输入', async () => {
    const user = userEvent.setup(), adapter = client()
    let finish!: (value: Awaited<ReturnType<NonNullable<ConversationAiAdapter['createThread']>>>) => void
    adapter.listThreads = async () => []
    adapter.createThread = vi.fn(() => new Promise<AiThread>(resolve => { finish = resolve }))
    render(<Fixture adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.type(screen.getByRole('textbox'), '第一条问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
    await user.type(screen.getByRole('textbox'), '下一条草稿')
    await act(async () => finish({ id: 'new', conversationId: 'c', title: '新对话', createdAtMs: 1, updatedAtMs: 1, turns: [] }))
    await screen.findByText('回答')
    expect(adapter.respond).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: 'new', prompt: '第一条问题' }), expect.anything())
    expect(screen.getByRole('textbox')).toHaveValue('下一条草稿')
  })

  it('新建按钮等待回执时编辑的原对话草稿在切回后仍保留', async () => {
    const user = userEvent.setup(), adapter = client()
    let finish!: (value: Awaited<ReturnType<NonNullable<ConversationAiAdapter['createThread']>>>) => void
    adapter.listThreads = async () => [{ id: 'first', conversationId: 'c', title: '原对话', createdAtMs: 1, updatedAtMs: 1 }]
    adapter.restoreThread = async () => []
    adapter.createThread = vi.fn(() => new Promise<AiThread>(resolve => { finish = resolve }))
    render(<Fixture adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.type(screen.getByRole('textbox'), '原草稿')
    await user.click(screen.getByRole('button', { name: '新建 AI 对话' }))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), '等待时改过的草稿')
    await act(async () => finish({ id: 'new', conversationId: 'c', title: '新对话', createdAtMs: 2, updatedAtMs: 2, turns: [] }))
    await user.click(screen.getByRole('button', { name: '显示对话列表' }))
    await user.click(screen.getByRole('button', { name: '原对话' }))
    expect(screen.getByRole('textbox')).toHaveValue('等待时改过的草稿')
  })

  it('只从顶部入口打开侧窗，关闭后回到入口且保留草稿', async () => {
    const user = userEvent.setup()
    render(<Fixture adapter={client()} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    const entry = within(screen.getByRole('region', { name: '原文' })).getByRole('button', { name: 'AI 对话' })
    await user.click(entry)
    await user.type(screen.getByRole('textbox'), '下一条问题')
    await user.click(screen.getByRole('button', { name: '关闭 AI 对话' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(entry).toHaveFocus())
    await user.click(entry)
    expect(screen.getByRole('textbox')).toHaveValue('下一条问题')
    expect(screen.queryByText('继续 AI 对话')).not.toBeInTheDocument()
  })

  it('取消选择会清除所有消息高亮，并可继续重新选择', async () => {
    const user = userEvent.setup()
    render(<App client={createPreviewClient([{ id: 'c', title: '示例聊天', messages: [{ id: '1', sender: '甲', text: '第一条' }, { id: '2', sender: '乙', text: '第二条' }] }])} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(await screen.findByRole('button', { name: '示例聊天' }))
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('option', { name: '甲：第一条' }))
    await user.click(screen.getByRole('option', { name: '乙：第二条' }))
    await user.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0)
    expect(screen.queryByText('已选 2 条')).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '甲：第一条' }))
    expect(screen.getByRole('option', { name: '甲：第一条' })).toHaveAttribute('aria-selected', 'true')
  })

  it('缺少部分统计时只展示已知用量，不添加统计不完整提示', async () => {
    const user = userEvent.setup(), adapter = client()
    adapter.respond = async () => ({ text: '本轮回答', usage: { outputTokens: 12, incomplete: true } })
    render(<Fixture adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.type(screen.getByRole('textbox'), '统计问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await screen.findByText('本轮回答')
    expect(screen.queryByText('统计不完整')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /输出 12/ }))
    const stats = screen.getByRole('region', { name: '生成统计' })
    expect(stats).toHaveTextContent('12 Tokens')
    expect(stats).toHaveTextContent('模型生成 TPS')
    expect(stats).not.toHaveTextContent('0 Tokens')
  })

  it('新建和切换对话保持独立消息、草稿，并将请求发到所选线程', async () => {
    const user = userEvent.setup(), adapter = client()
    const first = { id: 'first', conversationId: 'c', title: '第一次复盘', createdAtMs: 1, updatedAtMs: 1 }
    const second = { id: 'second', conversationId: 'c', title: '新对话', createdAtMs: 2, updatedAtMs: 2, turns: [] }
    adapter.listThreads = vi.fn(async () => [first])
    adapter.createThread = vi.fn(async () => second)
    adapter.restoreThread = vi.fn(async (_conversation, id) => id === 'first' ? [{ id: 't', requestId: 'old', prompt: '以前的问题', referenceIds: [], modelId: 'm', text: '以前的回答', state: 'completed' as const }] : [])
    render(<Fixture adapter={adapter} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await screen.findByText('以前的回答')
    await user.type(screen.getByRole('textbox'), '原对话草稿')
    await user.click(screen.getByRole('button', { name: '新建 AI 对话' }))
    expect(adapter.createThread).toHaveBeenCalledWith('c')
    expect(screen.queryByText('以前的回答')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
    await user.type(screen.getByRole('textbox'), '第二个问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await screen.findByText('回答')
    expect(adapter.respond).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'second', prompt: '第二个问题', history: [] }), expect.anything())
    await user.click(screen.getByRole('button', { name: '显示对话列表' }))
    await user.click(screen.getByRole('button', { name: '第一次复盘' }))
    await screen.findByText('以前的回答')
    expect(screen.getByRole('textbox')).toHaveValue('原对话草稿')
    expect(within(screen.getByRole('log')).queryByText('第二个问题')).not.toBeInTheDocument()
  })
})
