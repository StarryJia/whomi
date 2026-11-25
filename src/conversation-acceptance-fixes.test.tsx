import { render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import App from './App'
import { ConversationReader } from './components/conversations'
import { ReadOnlyMessages } from './components/insights/read-only-messages'
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

test.each(['partial', 'ready'] as const)('%s with no usable observations retains all four unknown dimensions and an empty Spark section', status => {
  render(<Overview data={{ materialStatus: status, discoveries: [], preferences: { energy: { status: 'unknown' } } }} />)
  expect(screen.getByRole('heading', { name: '你的人格倾向' })).toBeVisible()
  expect(screen.queryByText('材料不足的维度保留问号。')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: /Spark/ })).toBeVisible()
  expect(screen.getAllByText('尚待了解')).toHaveLength(4)
})

test.each(['awaiting_commit', 'committing', 'failed'] as const)('import plus restores a %s batch and its available actions', async status => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  const candidates = [candidate(), candidate('b')]
  vi.mocked(api.startImport).mockImplementation(async request => {
    if (request.kind === 'stage') emit(snapshot({ status: 'awaiting_commit', candidates }))
    else if (status === 'failed') emit(snapshot({ status, candidates, failurePhase: 'save', issues: [
      { code: 'DISK_SPACE', severity: 'blocking', candidateId: 'a', action: '请释放磁盘空间后重试。' },
    ] }))
    else emit(snapshot({ status: 'committing', candidates, progress: { processed: 120, total: 500 } }))
    return 'job'
  })
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  const first = await screen.findByRole('checkbox', { name: '会话 a' })
  if (status !== 'awaiting_commit') {
    await user.click(first)
    await user.click(screen.getByRole('button', { name: '导入所选会话' }))
  }
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await waitFor(() => expect(localStorage.getItem('whomi:import-job')).toBe('job'))
  if (status === 'awaiting_commit') {
    expect(await screen.findByRole('heading', { name: '选择要导入的会话' })).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '会话 b' })).toBeVisible()
    expect(screen.getByRole('button', { name: '导入所选会话' })).toBeDisabled()
  } else if (status === 'committing') {
    expect(await screen.findByRole('heading', { name: '正在保存' })).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '保存进度' })).toHaveAttribute('value', '120')
  } else {
    expect(await screen.findByRole('heading', { name: '保存失败' })).toBeVisible()
    expect(screen.getByRole('button', { name: '查看错误日志' })).toBeVisible()
  }
  expect(screen.getByRole('button', { name: '取消导入' })).toBeVisible()
  expect(api.startImport).toHaveBeenCalledTimes(status === 'awaiting_commit' ? 1 : 2)
  expect(api.cancelImport).not.toHaveBeenCalled()
})

test('import plus starts a new selection when the previous version left a partially completed batch', async () => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  localStorage.setItem('whomi:import-job', 'job')
  emit(snapshot({ status: 'partially_completed', candidates: [candidate(), candidate('b')], inserted: 500,
    results: [saved('a', '7'), saved('b', '8', { status: 'failed', conversationId: null, committedAt: null, inserted: 0 })],
  }))
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeEnabled()
  expect(localStorage.getItem('whomi:import-job')).toBeNull()
  expect(api.cancelImport).not.toHaveBeenCalled()
  expect(api.deleteConversation).not.toHaveBeenCalled()
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

test('insight reply uses the loaded original when the excerpt lacks its own sender and text', async () => {
  const rows = await messages()
  rows[1] = { ...rows[1], reply: { ...rows[1].reply!, senderName: null, text: null } }
  const open = vi.fn()
  render(<ReadOnlyMessages messages={rows} highlightIds={['2']} onOpenReply={open} />)

  const quote = screen.getByRole('button', { name: /查看引用原消息/ })
  expect(quote).toHaveTextContent('示例甲')
  expect(quote.querySelector('span')?.textContent).toBe('原消息\n保留换行')
  await userEvent.setup().click(quote)
  expect(open).toHaveBeenCalledWith('1', '2')
  expect(screen.getAllByText('时间未知')).toHaveLength(1)
})

test('reply bubble jumps to the real message without selecting it and can return to the reply', async () => {
  const user = userEvent.setup()
  render(<ConversationReader conversation={{ id: 'example', title: '引用示例', messages: await messages() }} />)
  await user.click(screen.getByRole('button', { name: '选择消息' }))
  await user.click(screen.getByRole('button', { name: /查看引用原消息/ }))
  expect(document.querySelector('[data-message-id="1"]')).toHaveClass('message-reference-target')
  expect(screen.getByRole('button', { name: '选择消息' })).toHaveAttribute('aria-pressed', 'false')
  expect(document.querySelectorAll('.message-selected, .message[aria-selected]')).toHaveLength(0)
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
