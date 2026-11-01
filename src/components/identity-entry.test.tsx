import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { MemberView } from '../shared/desktop-api'
import { ConversationReader } from './conversations'

const members: MemberView[] = [
  { id: '1', displayName: '小禾', selfHint: true, confirmedSelf: false },
  { id: '2', displayName: '小松', selfHint: false, confirmedSelf: false },
]
const conversation = { id: '1', title: '虚构出行', messages: [] }
const prompt = () => screen.findByRole('dialog', { name: '选择本人' })

it('进入未确认会话可取消并回到选择本人入口，刷新不重复，重进仍提示直到确认', async () => {
  const user = userEvent.setup()
  let self: string | null = null
  const api = {
    listMembers: vi.fn(async () => members.map(member => ({ ...member, confirmedSelf: member.id === self }))),
    confirmSelf: vi.fn(async (_id: string, id: string | null) => { self = id }), deleteConversation: vi.fn(),
  }
  const view = render(<ConversationReader api={api} conversation={conversation} />)
  const first = await prompt()
  expect(within(first).getByText('这段聊天里，哪位是你？')).toBeVisible()
  expect(within(first).getByRole('button', { name: '设为本人' })).toBeDisabled()
  await user.click(within(first).getByRole('button', { name: '取消' }))
  expect(screen.getByText('可在这里选择本人')).toBeVisible()
  expect(screen.getByRole('button', { name: '选择本人' })).toHaveFocus()
  view.rerender(<ConversationReader api={api} conversation={{ ...conversation, messages: [] }} />)
  expect(api.listMembers).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.confirmSelf).not.toHaveBeenCalled()
  view.unmount()
  const revisit = render(<ConversationReader api={api} conversation={conversation} />)
  const next = await prompt()
  await user.click(within(next).getByRole('radio', { name: '小松' }))
  await user.click(within(next).getByRole('button', { name: '设为本人' }))
  expect(api.confirmSelf).toHaveBeenCalledWith('1', '2')
  revisit.unmount()
  render(<ConversationReader api={api} conversation={conversation} />)
  await waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(3))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('原文工具栏直接选择本人，取消和原生关闭后恢复入口焦点', async () => {
  const user = userEvent.setup()
  const api = { listMembers: vi.fn(async () => members.map(member => ({ ...member, confirmedSelf: member.id === '1' }))), confirmSelf: vi.fn() }
  render(<ConversationReader api={api} conversation={conversation} />)
  await waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(1))
  const button = screen.getByRole('button', { name: '选择本人' })
  expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除会话' })).toBeNull()
  await user.click(button)
  expect(await prompt()).toBeVisible()
  fireEvent(await prompt(), new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(button).toHaveFocus()
  await user.keyboard('{Enter}')
  await user.click(within(await prompt()).getByRole('button', { name: '取消' }))
  expect(button).toHaveFocus()
  expect(api.confirmSelf).not.toHaveBeenCalled()
})

it('成员读取失败可重试，来源推测仍需用户确认', async () => {
  const user = userEvent.setup()
  const api = { listMembers: vi.fn().mockRejectedValueOnce({ action: '请重新读取成员。' }).mockResolvedValue(members),
    confirmSelf: vi.fn(), deleteConversation: vi.fn() }
  render(<ConversationReader api={api} conversation={conversation} />)
  const dialog = await prompt()
  expect(within(dialog).getByRole('alert')).toHaveTextContent('请重新读取成员。')
  await user.click(within(dialog).getByRole('button', { name: '重新读取成员' }))
  expect(await within(dialog).findByText('来源推测')).toBeVisible()
  expect(within(dialog).getByRole('button', { name: '设为本人' })).toBeDisabled()
})
