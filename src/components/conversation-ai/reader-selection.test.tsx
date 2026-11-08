import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFixtureDrafts, composerTextbox, expectComposerText, pasteComposerText } from '../../test/cherry-composer-helpers'
import type { ConversationAiAdapter } from './types'
import { ConversationReader } from '../conversations'
import { createPreviewClient } from '../../data/preview-client'
import App from '../../App'

beforeEach(() => clearFixtureDrafts('c'))

async function conversation(id = 'c') {
  const client = createPreviewClient([{ id, title: '选择模式示例', messages: [
    { id: '1', sender: '小林', text: '先读这句话。' },
    { id: '2', sender: '我', text: '再看这句话。' },
  ] }])
  return { id, title: '选择模式示例', messages: (await client.readMessages({ conversationId: id, direction: 'after' })).items }
}

describe('阅读与消息选择模式', () => {
  it.each(['已发送引用', '待发送引用', '消息内引用'])('选择消息后查看%s退出选择，只显示引用描边并保留草稿', async entry => {
    const user = userEvent.setup()
    const full = await conversation()
    full.messages[1] = { ...full.messages[1], reply: { targetMessageId: '1', originalId: 'm1',
      idNamespace: 'example', text: '引用第一句', senderName: '小林', sentAtMs: null, state: 'resolved' } }
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => [{ id: 'turn', requestId: 'r', prompt: '核对原文',
        referenceIds: ['1'], modelId: 'm', text: '回答', state: 'completed' }],
    }
    render(<ConversationReader conversation={full} aiAdapter={adapter} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await pasteComposerText('保留这个问题')
    const toggle = screen.getByRole('button', { name: '选择消息' })
    await user.click(toggle)
    await user.click(screen.getByRole('option', { name: '小林：先读这句话。' }))
    expect(document.querySelectorAll('.message-selected')).toHaveLength(1)

    if (entry === '待发送引用') {
      await user.click(screen.getByRole('button', { name: '1 组引用' }))
      await user.click(screen.getByRole('button', { name: /引用 1 · 小林/ }))
    } else if (entry === '消息内引用') {
      await user.click(screen.getByRole('button', { name: '查看引用原消息：小林：引用第一句' }))
    } else {
      await user.click(await screen.findByRole('button', { name: '1 条引用' }))
    }

    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.message-selected')).toHaveLength(0)
    expect(document.querySelectorAll('.selection-joined-before, .selection-joined-after')).toHaveLength(0)
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '1 组引用' })).toBeVisible()
    await expectComposerText('保留这个问题')
    await user.click(screen.getByText('先读这句话。'))
    expect(screen.getByRole('button', { name: '1 组引用' })).toBeVisible()

    await user.click(toggle)
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(0)
    expect(screen.getByRole('option', { name: '小林：先读这句话。' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelectorAll('.message-selected')).toHaveLength(1)
  })

  it('跨页查看引用立即退出选择，定位失败后可重试且不丢失已选消息', async () => {
    const user = userEvent.setup()
    const full = await conversation()
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finish = resolve })
    const locate = vi.fn().mockImplementationOnce(() => pending).mockImplementationOnce(async () => {
      view.rerender(reader(full.messages))
      return true
    })
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => [{ id: 'turn', requestId: 'r', prompt: '核对原文',
        referenceIds: ['1'], modelId: 'm', text: '回答', state: 'completed' }],
    }
    const reader = (messages: typeof full.messages) => <ConversationReader conversation={{ ...full, messages }} aiAdapter={adapter} onLocateMessageId={locate} />
    const view = render(reader(full.messages.slice(1)))
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    const toggle = screen.getByRole('button', { name: '选择消息' })
    await user.click(toggle)
    await user.click(screen.getByRole('option', { name: '我：再看这句话。' }))
    await user.click(await screen.findByRole('button', { name: '1 条引用' }))
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelectorAll('.message-selected')).toHaveLength(0)
    await act(async () => { finish(false); await pending })
    await user.click(await screen.findByRole('button', { name: '重试定位' }))
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(1)
    expect(document.querySelectorAll('.message-selected')).toHaveLength(0)
    expect(locate).toHaveBeenCalledTimes(2)
    await user.click(toggle)
    expect(screen.getByRole('option', { name: '我：再看这句话。' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(0)
  })

  it('查看引用后开启选择会清除定位标记，退出选择不恢复标记，并保留已选消息和草稿', async () => {
    const user = userEvent.setup()
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => [{ id: 'turn', requestId: 'r', prompt: '核对原文',
        referenceIds: ['1', '2'], modelId: 'm', text: '回答', state: 'completed' }],
    }
    render(<ConversationReader conversation={await conversation()} aiAdapter={adapter} />)
    const toggle = screen.getByRole('button', { name: '选择消息' })
    await user.click(toggle)
    await user.click(screen.getByRole('option', { name: '小林：先读这句话。' }))
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await pasteComposerText('保留这个问题')
    await user.click(await screen.findByRole('button', { name: '2 条引用' }))
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(2)
    expect(document.querySelectorAll('.message-selected')).toHaveLength(0)

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(0)
    expect(screen.getByRole('option', { name: '小林：先读这句话。' })).toHaveAttribute('aria-selected', 'true')
    await expectComposerText('保留这个问题')
    expect(screen.getByRole('button', { name: '1 组引用' })).toBeVisible()
    await user.click(toggle)
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(0)
    await user.click(await within(screen.getByRole('log')).findByRole('button', { name: '2 条引用' }))
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(2)
  })

  it.each([true, false])('开启选择后忽略未完成引用定位的回执（成功：%s）', async located => {
    const user = userEvent.setup()
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finish = resolve })
    const full = await conversation()
    const locate = vi.fn(async () => {
      const result = await pending
      if (result) view.rerender(reader(full.messages))
      return result
    })
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => [{ id: 'turn', requestId: 'r', prompt: '核对原文',
        referenceIds: ['1'], modelId: 'm', text: '回答', state: 'completed' }],
    }
    const reader = (messages: typeof full.messages) => <ConversationReader conversation={{ ...full, messages }} aiAdapter={adapter} onLocateMessageId={locate} />
    const view = render(reader(full.messages.slice(1)))
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.click(await screen.findByRole('button', { name: '1 条引用' }))
    const toggle = screen.getByRole('button', { name: '选择消息' })
    await user.click(toggle)
    await act(async () => { finish(located); await pending })
    expect(toggle).toHaveFocus()
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '重试定位' })).not.toBeInTheDocument()
    // 下一次定位当前页消息应直接完成，不沿用已取消请求的忙碌状态。
    await user.click(screen.getByRole('option', { name: '我：再看这句话。' }))
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: '1 组引用' }))
    await user.click(screen.getByRole('button', { name: /引用 1 · 我/ }))
    expect(document.querySelector('[data-message-id="2"]')).toHaveClass('message-reference-target')
    expect(locate).toHaveBeenCalledTimes(1)
  })

  it('开启选择清除引用定位失败的重试入口', async () => {
    const user = userEvent.setup()
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => [{ id: 'turn', requestId: 'r', prompt: '核对原文',
        referenceIds: ['missing'], modelId: 'm', text: '回答', state: 'completed' }],
    }
    render(<ConversationReader conversation={await conversation()} aiAdapter={adapter} onLocateMessageId={async () => false} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.click(await screen.findByRole('button', { name: '1 条引用' }))
    expect(await screen.findByRole('button', { name: '重试定位' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    expect(screen.queryByRole('button', { name: '重试定位' })).not.toBeInTheDocument()
  })

  it('跨页定位未完成又点击当前页引用时，以最后点击的引用为准', async () => {
    const user = userEvent.setup()
    const client = createPreviewClient([{ id: 'c', title: '连续核对', messages: Array.from({ length: 110 }, (_, i) => ({
      id: String(i + 1), sender: '小林', text: `原文 ${i + 1}`,
    })) }])
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    const find = client.locateSource
    const locate = vi.spyOn(client, 'locateSource').mockImplementation(async input => {
      if (input.messageId === '110') await delayed
      return find(input)
    })
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => ['110', '1'].map(id => ({ id, requestId: id, prompt: `核对 ${id}`,
        referenceIds: [id], modelId: 'm', text: '回答', state: 'completed' })),
    }
    render(<App client={client} conversationAiAdapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(await screen.findByRole('button', { name: '连续核对' }))
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    const [offPage, onPage] = await within(screen.getByRole('log')).findAllByRole('button', { name: '1 条引用' })
    await user.click(offPage)
    expect(locate).toHaveBeenCalledWith({ conversationId: 'c', messageId: '110' })
    await user.click(onPage)
    await act(async () => { release(); await delayed })
    expect(document.querySelector('[data-message-id="1"]')).toHaveFocus()
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(1)
    expect(document.querySelector('.message-reference-target')).toHaveAttribute('data-message-id','1')
  })

  it('恢复后的 19 条引用可以重试定位，只高亮真实引用编号，后加载的消息保留高亮', async () => {
    const user = userEvent.setup()
    const ids = Array.from({ length: 19 }, (_, index) => String(index * 2 + 1))
    const client = createPreviewClient([{ id: 'c', title: '跨页核对', messages: Array.from({ length: 40 }, (_, index) => ({
      id: String(index + 1), sender: '小林', text: `消息 ${index + 1}`,
    })) }])
    const { items } = await client.readMessages({ conversationId: 'c', direction: 'after' })
    const adapter: ConversationAiAdapter = {
      models: [], skills: [], respond: vi.fn(), analyze: vi.fn(),
      restoreThread: async () => [{ id: '1', requestId: 'r', prompt: '一起核对', referenceIds: ids, modelId: 'm', text: '回答', state: 'completed' }],
    }
    const locate = vi.fn().mockResolvedValueOnce(false).mockImplementation(async () => {
      view.rerender(reader(items.slice(0, 9)))
      return true
    })
    const reader = (messages: typeof items) => <ConversationReader conversation={{ id: 'c', title: '跨页核对', messages }}
      aiAdapter={adapter} onLocateMessageId={locate} />
    const view = render(reader(items.slice(-2)))
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.click(await screen.findByRole('button', { name: '19 条引用' }))
    await user.click(await screen.findByRole('button', { name: '重试定位' }))
    expect(locate).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-message-id="1"]')).toHaveFocus()
    expect(document.querySelectorAll('.message-reference-target')).toHaveLength(5)
    view.rerender(reader(items))
    expect(Array.from(document.querySelectorAll<HTMLElement>('.message-reference-target'), element => element.dataset.messageId)).toEqual(ids)
  })

  it('默认阅读不添加引用，显式开启后才能选择，退出保留引用和草稿', async () => {
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} />)
    await user.click(screen.getByText('先读这句话。'))
    expect(screen.queryByRole('button', { name: '1 组引用' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.message[tabindex="0"]')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await pasteComposerText('保留问题')
    const toggle = screen.getByRole('button', { name: '选择消息', pressed: false })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /清空已选|完成选择/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '小林：先读这句话。' }))
    expect(screen.queryByText('已选 1 条')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '1 组引用' })).toBeInTheDocument()
    await expectComposerText('保留问题')
    await user.click(screen.getByText('再看这句话。'))
    expect(document.querySelectorAll('.message-selected')).toHaveLength(1)
  })

  it('按组移除同步原文，删除最后一组或清空全部后可继续写同一草稿', async () => {
    const user = userEvent.setup()
    const client = createPreviewClient([{ id: 'c', title: '逐组核对', messages: Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 1), sender: '小林', text: `原文 ${index + 1}`,
    })) }])
    const { items } = await client.readMessages({ conversationId: 'c', direction: 'after' })
    const adapter: ConversationAiAdapter = { models: [{ id: 'a', label: '甲模型' }, { id: 'b', label: '乙模型' }],
      selectedModels: { conversation: 'b' }, skills: [], respond: vi.fn(), analyze: vi.fn() }
    render(<ConversationReader conversation={{ id: 'c', title: '逐组核对', messages: items }} aiAdapter={adapter} />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await pasteComposerText('接下来该怎么回应？')
    const draft = await composerTextbox()
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    const message = (n: number) => screen.getByRole('option', { name: `小林：原文 ${n}` })
    for (const n of [1, 2, 4]) await user.click(message(n))
    const entry = screen.getByRole('button', { name: '2 组引用' })
    expect(draft.closest('[data-composer-inputbar]')).toContainElement(entry)
    expect(draft.closest('[data-composer-editor-frame]')).not.toContainElement(entry)
    await user.click(entry)
    const list = screen.getByRole('region', { name: '引用预览' })
    expect(within(list).getByText(/共 2 条消息/)).toBeVisible()
    const remove = within(list).getByRole('button', { name: '移除第 1 组引用' })
    expect(remove.parentElement?.closest('button')).toBeNull()
    await user.click(remove)
    expect(message(1)).toHaveAttribute('aria-selected', 'false')
    expect(message(2)).toHaveAttribute('aria-selected', 'false')
    expect(message(4)).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.message-reference-target')).toBeNull()
    expect(within(list).getByText(/原文 4/)).toBeVisible()
    expect(screen.getByRole('button', { name: '1 组引用' })).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    const remaining = screen.getByRole('button', { name: '1 组引用' })
    expect(remaining).toHaveFocus()
    await user.keyboard('{Enter}{ArrowDown}')
    await waitFor(() => expect(within(screen.getByRole('region', { name: '引用预览' })).getByRole('button', { name: /引用 1 · 小林/ })).toHaveFocus())
    await user.tab()
    expect(screen.getByRole('button', { name: '移除第 1 组引用' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('region', { name: '引用预览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /组引用/ })).not.toBeInTheDocument()
    await waitFor(() => expect(draft).toHaveFocus())
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0)
    for (const n of [1, 4]) await user.click(message(n))
    await user.click(screen.getByRole('button', { name: '清空全部引用' }))
    expect(screen.queryByRole('button', { name: /组引用/ })).not.toBeInTheDocument()
    expect(document.querySelectorAll('.message-selected')).toHaveLength(0)
    await expectComposerText('接下来该怎么回应？')
    expect(screen.getByRole('combobox', { name: '对话模型' })).toHaveAttribute('title', '乙模型')
    expect(adapter.respond).not.toHaveBeenCalled()
  })

  it('Escape 先关闭分析浮窗，再退出选择；切换会话恢复阅读', async () => {
    const user = userEvent.setup()
    const first = await conversation()
    const view = render(<ConversationReader conversation={first} />)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('button', { name: '整理成记忆' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '记忆生成状态' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择消息', pressed: true })).toBeVisible()
    fireEvent.keyDown(screen.getByRole('region', { name: '聊天记录' }), { key: 'Escape' })
    expect(screen.getByRole('button', { name: '选择消息' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    view.rerender(<ConversationReader conversation={await conversation('second')} />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('编辑问题时 Escape 不改变消息选择模式或草稿', async () => {
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} />)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await pasteComposerText('正在编辑的问题')
    const draft = await composerTextbox()
    act(() => draft.focus())
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '选择消息', pressed: true })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'AI 对话' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await expectComposerText('正在编辑的问题')
  })
})
