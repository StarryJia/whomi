import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import type { Conversation } from './components/conversations'
import type { ClarificationAdapter, ClarificationQuestion } from './components/clarification/types'

const conversations: Conversation[] = [{ id: 'friends', title: '答辩前的安排', messages: [
  { id: 'before', sender: '朋友', text: '下周要答辩了。' },
  { id: 'start', sender: '朋友', text: '昨晚试了一遍，讲到方法那里就卡住了。' },
  { id: 'middle', sender: '我', text: '是图没讲明白，还是时间太紧？', isSelf: true },
  { id: 'end', sender: '朋友', text: '主要是图，我想找个人听一下。' },
  { id: 'after', sender: '我', text: '那我们明天试一遍。', isSelf: true },
] }]
const question: ClarificationQuestion = {
  id: 'defense', title: '那次你更想怎样帮朋友？', context: '朋友准备答辩时遇到困难，你们讨论了试讲和时间。',
  options: [
    { id: 'listen', title: '更想先听他说完' },
    { id: 'help', title: '想帮他赶完眼前的事' },
    { id: 'ask', title: '当时只是顺手问了问' },
  ],
  source: { id: 'scene', conversationId: 'friends', messageId: 'start', endMessageId: 'end', title: '答辩前的安排', context: '试讲前的准备与约定。' },
}
const adapter: ClarificationAdapter = {
  submit: async () => ({ answerId: 'answer', persistence: 'preview' }),
  withdraw: async () => ({ persistence: 'preview' }),
}

beforeEach(() => {
  const matchMedia = window.matchMedia
  window.matchMedia = query => ({ ...matchMedia(query), matches: query === '(prefers-reduced-motion: reduce)' })
})

describe('问一问与情景阅读往返', () => {
  it('回顾原文定位整段范围，返回同题仍保留自己回答草稿', async () => {
    const user = userEvent.setup()
    render(<App conversations={conversations} clarificationQuestion={question} clarificationAdapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '问一问' }))
    await user.type(screen.getByRole('textbox'), '我担心他一个人熬得太晚。')
    await user.click(screen.getByRole('button', { name: '回顾那段情景' }))
    const reader = screen.getByRole('region', { name: '聊天记录' })
    expect(reader.querySelectorAll('.message-source')).toHaveLength(3)
    expect(within(reader).getByText('下周要答辩了。')).toBeInTheDocument()
    expect(within(reader).getByText('那我们明天试一遍。')).toBeInTheDocument()
    await waitFor(() => expect(within(reader).getByText('昨晚试了一遍，讲到方法那里就卡住了。').closest('li')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: '返回问一问' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '问一问' })).toHaveFocus())
    expect(screen.getByRole('heading', { name: question.title })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('我担心他一个人熬得太晚。')
    expect(screen.getByRole('button', { name: /更想先听他说完/ })).toBeDisabled()
  })

  it('品牌返回移除问一问内容，重新进入仍保留当前回答并可撤回', async () => {
    const user = userEvent.setup()
    render(<App clarificationQuestion={question} clarificationAdapter={adapter} />)
    await user.click(screen.getByRole('button', { name: '问一问' }))
    await user.click(screen.getByRole('button', { name: /更想先听他说完/ }))
    await screen.findByRole('button', { name: '撤回回答' })
    await user.click(screen.getByRole('link', { name: 'Whomi 首页' }))
    expect(screen.queryByRole('heading', { name: question.title })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: '问一问' }))
    expect(screen.getByRole('button', { name: '撤回回答' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '撤回回答' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /更想先听他说完/ })).toBeEnabled())
    expect(screen.getByRole('heading', { name: question.title })).toBeInTheDocument()
  })
})
