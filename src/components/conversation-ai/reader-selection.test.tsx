import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationAiAdapter } from './types'
import { ConversationReader } from '../conversations'
import { createPreviewClient } from '../../data/preview-client'
import App from '../../App'

async function conversation(id = 'c') {
  const client = createPreviewClient([{ id, title: '选择模式示例', messages: [
    { id: '1', sender: '小林', text: '先读这句话。' },
    { id: '2', sender: '我', text: '再看这句话。' },
  ] }])
  return { id, title: '选择模式示例', messages: (await client.readMessages({ conversationId: id, direction: 'after' })).items }
}

describe('阅读与消息选择模式', () => {
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
    expect(screen.queryByRole('button', { name: '1 条引用' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.message[tabindex="0"]')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.type(screen.getByRole('textbox'), '保留问题')
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    expect(screen.getByRole('button', { name: '退出选择' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('option', { name: '小林：先读这句话。' }))
    await user.click(screen.getByRole('button', { name: '退出选择' }))
    expect(screen.getByRole('button', { name: '1 条引用' })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('保留问题')
    await user.click(screen.getByText('再看这句话。'))
    expect(document.querySelectorAll('.message-selected')).toHaveLength(1)
  })

  it('Escape 先关闭分析浮窗，再退出选择；切换会话恢复阅读', async () => {
    const user = userEvent.setup()
    const first = await conversation()
    const view = render(<ConversationReader conversation={first} />)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('button', { name: '整理成记忆' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '记忆生成状态' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出选择' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('region', { name: '聊天记录' }), { key: 'Escape' })
    expect(screen.getByRole('button', { name: '选择消息' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    view.rerender(<ConversationReader conversation={await conversation('second')} />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('编辑问题时 Escape 不改变消息选择模式或草稿', async () => {
    const user = userEvent.setup()
    render(<ConversationReader conversation={await conversation()} />)
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await user.type(screen.getByRole('textbox'), '正在编辑的问题{Escape}')
    expect(screen.getByRole('button', { name: '退出选择' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'AI 对话' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    expect(screen.getByRole('textbox')).toHaveValue('正在编辑的问题')
  })
})
