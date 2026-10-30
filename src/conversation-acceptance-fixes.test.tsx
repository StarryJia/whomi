import { act, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import App from './App'
import { ConversationReader } from './components/conversations'
import { PersonalOverview } from './components/overview/personal-overview'
import { useOverviewFeedback } from './components/overview/use-overview-feedback'
import type { OverviewData } from './components/overview/types'
import { createPreviewClient } from './data/preview-client'
import { candidate, fakeImportApi, saved, snapshot } from './test/import-api'

function Overview({ data }: { data: OverviewData }) {
  const feedback = useOverviewFeedback()
  return <PersonalOverview data={data} headingRef={createRef()} onReturnToCover={() => {}} onImport={() => {}}
    onOpenSource={() => {}} isSourceAvailable={() => true} feedback={feedback} />
}

test.each(['partial', 'ready'] as const)('%s with no usable observations has one compact empty state', status => {
  render(<Overview data={{ materialStatus: status, discoveries: [], preferences: { energy: { status: 'unknown' } } }} />)
  expect(screen.queryByRole('heading', { name: '人格偏好' })).not.toBeInTheDocument()
  expect(screen.queryByText('材料不足的维度保留问号。')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /Spark/ })).not.toBeInTheDocument()
  expect(screen.getByText('暂时还没有形成可展示的观察。')).toBeInTheDocument()
})

test.each(['awaiting_commit', 'committing', 'partially_completed'] as const)('import plus preserves a %s task and its recovery entry', async status => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByText('两层目录中的记录.json')
  const results = status === 'partially_completed' ? [saved('a', '7'), saved('b', '8', { status: 'failed', conversationId: null, committedAt: null })] : []
  act(() => emit(snapshot({ status, candidates: [candidate()], results })))
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await waitFor(() => expect(localStorage.getItem('whomi:import-job')).toBe('job'))
  if (status === 'awaiting_commit') expect(await screen.findByRole('button', { name: '确认保存' })).toBeInTheDocument()
  else if (status === 'committing') expect(await screen.findByText('正在保存…')).toBeInTheDocument()
  else expect(await screen.findByText('已保存 500 条消息。')).toBeInTheDocument()
  expect(api.cancelImport).not.toHaveBeenCalled()
})

async function messages() {
  const client = createPreviewClient([{ id: 'example', title: '引用示例', messages: [
    { id: '1', sender: '示例甲', text: '原消息\n保留换行' },
    { id: '2', sender: '示例乙', text: '  好听诶  ' },
    { id: '3', sender: '示例乙', text: '[动画表情]' },
  ] }])
  const page = await client.readMessages({ conversationId: 'example', direction: 'after' })
  page.items[1] = { ...page.items[1], kind: 'reply', reply: { targetMessageId: '1', originalId: 'm1', idNamespace: 'example', text: '原消息\n保留换行', senderName: '示例甲', sentAtMs: null, state: 'resolved' } }
  page.items[2] = { ...page.items[2], kind: 'sticker', attachments: [{ kind: 'sticker', name: '附件', state: 'missing' }] }
  return page.items
}

test('reader retains verbatim content while omitting type and attachment diagnostics', async () => {
  render(<ConversationReader conversation={{ id: 'example', title: '引用示例', messages: await messages() }} />)
  expect(screen.queryByText(/消息类型：/)).not.toBeInTheDocument()
  expect(screen.queryByText(/文件缺失|文件未导入/)).not.toBeInTheDocument()
  expect(screen.getByText('[动画表情]')).toBeInTheDocument()
  expect(document.querySelectorAll('.message-text')[1].textContent).toBe('  好听诶  ')
})

test('reply bubble jumps to the real message without selecting it and can return to the reply', async () => {
  const user = userEvent.setup()
  render(<ConversationReader conversation={{ id: 'example', title: '引用示例', messages: await messages() }} />)
  await user.click(screen.getByRole('button', { name: '选择消息' }))
  await user.click(screen.getByRole('button', { name: /查看引用原消息/ }))
  expect(document.querySelector('[data-message-id="1"]')).toHaveClass('message-reference-target')
  expect(document.querySelector('[data-message-id="2"]')).toHaveAttribute('aria-selected', 'false')
  await user.click(screen.getByRole('button', { name: '返回引用位置' }))
  expect(document.querySelector('[data-message-id="2"]')).toHaveFocus()
})

test('reply paging failure retains the reply and offers retry rather than guessing a target', async () => {
  const user = userEvent.setup()
  const rows = await messages()
  const locate = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(true)
  render(<ConversationReader conversation={{ id: 'example', title: '引用示例', messages: rows.slice(1) }} onLocateMessageId={locate} />)
  await user.click(screen.getByRole('button', { name: /查看引用原消息/ }))
  expect(locate).toHaveBeenCalledWith('1')
  expect(screen.getByText('未找到原消息，请重试。')).toBeInTheDocument()
  expect(document.querySelector('[data-message-id="2"]')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重试定位' }))
  expect(locate).toHaveBeenCalledTimes(2)
})

test('unresolved reply remains readable without a misleading jump button', async () => {
  const rows = await messages()
  rows[1] = { ...rows[1], reply: { ...rows[1].reply!, state: 'unresolved', targetMessageId: null } }
  render(<ConversationReader conversation={{ id: 'example', title: '引用示例', messages: rows }} />)
  expect(screen.queryByRole('button', { name: /查看引用原消息/ })).not.toBeInTheDocument()
  expect(document.querySelector('.message-quote')).toHaveTextContent('原消息')
})

test('a paged quote jump keeps focus on its target when an earlier source range is preserved', async () => {
  const user = userEvent.setup(), rows = await messages()
  function Reader() {
    const [items, setItems] = useState(rows.slice(1))
    const [status, setStatus] = useState<'loading' | 'available'>('available')
    return <ConversationReader conversation={{ id: 'example', title: '来源内引用示例', messages: items }}
      sourceStatus={status} range={{ start: rows[1], end: rows[1] }} onLocateMessageId={async () => {
        setStatus('loading')
        await new Promise(resolve => setTimeout(resolve, 10))
        setItems(rows); setStatus('available')
        return true
      }} />
  }
  render(<Reader />)
  await user.click(screen.getByRole('button', { name: /查看引用原消息/ }))
  await waitFor(() => expect(document.querySelector('[data-message-id="1"]')).toHaveFocus())
})
