import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ConversationReader } from '../conversations'
import { createPreviewClient } from '../../data/preview-client'

async function conversation(id = 'c') {
  const client = createPreviewClient([{ id, title: '选择模式示例', messages: [
    { id: '1', sender: '小林', text: '先读这句话。' },
    { id: '2', sender: '我', text: '再看这句话。' },
  ] }])
  return { id, title: '选择模式示例', messages: (await client.readMessages({ conversationId: id, direction: 'after' })).items }
}

describe('阅读与消息选择模式', () => {
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
    await user.click(screen.getByRole('button', { name: '会话分析' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '会话分析状态' })).not.toBeInTheDocument()
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
