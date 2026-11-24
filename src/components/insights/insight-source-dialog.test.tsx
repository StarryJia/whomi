import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'
import { InsightSourceDialog } from './insight-source-dialog'
import type { InsightCitationWindow } from '../../shared/conversation-insights'
import type { MessageView } from '../../shared/desktop-api'

function message(id: string): MessageView {
  return { id, conversationId: '9', memberId: '2', senderKind: 'member', senderName: '原始名字', isSelf: id === '12', sentAtMs: Number(id) * 1000,
    timeRaw: null, timePrecision: 'second', timezone: 'Asia/Shanghai', timeBucket: 0, sortTime: Number(id), ordinal: Number(id),
    kind: 'text', sourceType: null, text: '原文' + id, reply: null, attachments: [] }
}
function source(ids = ['10', '11', '12'], highlightIds = ['10', '12']): InsightCitationWindow {
  return { status: 'available', conversationId: '9', startMessageId: ids[0], endMessageId: ids.at(-1)!,
    start: { id: ids[0], timeBucket: 0, sortTime: 10 }, end: { id: ids.at(-1)!, timeBucket: 0, sortTime: 12 }, rangeEndCursor: 'end',
    page: { items: ids.map(message), beforeCursor: 'before', afterCursor: 'after', snapshotMaxId: '40' }, highlightIds }
}
test('旧报告的引用位置按系统通知展示，保留高亮和原文', async () => {
  const data = source(['10'], ['10'])
  if (data.status !== 'available') throw Error('缺少测试原文')
  Object.assign(data.page.items[0], { kind: 'system', senderKind: 'system', memberId: null, senderName: '旧导出昵称', text: '你撤回了一条消息' })
  render(<InsightSourceDialog {...props(vi.fn(async () => data))} />)
  const notice = await screen.findByText('你撤回了一条消息')
  expect(notice.closest('[data-citation="true"]')).toHaveAttribute('data-message-id', '10')
  expect(notice.closest('li')?.querySelector('.conversation-avatar,.message-meta,.message-text')).toBeNull()
  expect(screen.queryByText('旧导出昵称')).not.toBeInTheDocument()
})
function props(readCitation = vi.fn(async () => source())) {
  return { taskId: '7', citationId: 'e1', phrase: '那次准备', conversationTitle: '小林', onClose: vi.fn(), returnFocus: createRef<HTMLButtonElement>(), fragmentCount: 2,
    readCitation, client: { locateSource: vi.fn(), readMessages: vi.fn(async (input: { limit?: number }) => {
      if (input.limit !== undefined && input.limit !== 100) throw new Error('INVALID_CURSOR')
      return { items: [message('9')], beforeCursor: null, afterCursor: 'before', snapshotMaxId: '40' }
    }) } }
}
test('署名旁显示完整日期，并保留无法解析的原始时间', async () => {
  const data = source(['1', '2', '3'])
  if (data.status !== 'available') throw Error('缺少测试原文')
  for (const [index, row] of data.page.items.entries()) {
    row.sentAtMs = new Date(2026, 9, 10 + index, 9, 30).getTime()
  }
  Object.assign(data.page.items[2], { sentAtMs: null, timeBucket: 1, timeRaw: '周三上午' })
  render(<InsightSourceDialog {...props(vi.fn(async () => data))} />)
  await screen.findByText('原文1')
  const meta = (id: string) => document.querySelector(`[data-message-id="${id}"] .message-meta`)
  expect(meta('1')).toHaveTextContent('2026/10/10 09:30:00')
  expect(meta('2')).toHaveTextContent('2026/10/11 09:30:00')
  expect(meta('3')).toHaveTextContent('周三上午')
})
function replySource(targetId: string) {
  const data = source(['10', '11', '12'], ['10'])
  if (data.status !== 'available') throw Error('缺少测试原文')
  data.page.items[1].reply = { targetMessageId: targetId, originalId: null, idNamespace: null, text: '被回复的消息',
    senderName: null, sentAtMs: null, state: 'resolved' }
  data.page.items[2].reply = { ...data.page.items[1].reply, targetMessageId: null, state: 'unresolved' }
  return data
}
test.each(['12', '90'])('点回复定位原消息 %s，返回同一条回复并保留当前片段', async target => {
  const p = props(vi.fn(async () => replySource(target)))
  p.client.locateSource.mockResolvedValue(source(['89', '90']))
  render(<InsightSourceDialog {...p} />)
  const quote = await screen.findByRole('button', { name: /查看引用原消息/ })
  expect(screen.getByRole('blockquote')).toHaveTextContent('被回复的消息')
  fireEvent.click(quote)
  const row = (id: string) => document.querySelector(`[data-message-id="${id}"]`)
  await waitFor(() => expect(row(target)).toHaveFocus())
  expect(row(target)).toHaveClass('message-reference-target')
  expect(row(target)).toHaveAttribute('data-citation', 'false')
  if (target === '90') {
    expect(p.client.locateSource).toHaveBeenCalledWith({ conversationId: '9', messageId: '90' })
    expect(row('10')).toBeNull()
  } else expect(p.client.locateSource).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '返回引用位置' }))
  expect(row('11')).toHaveFocus()
  expect(row('10')).toHaveAttribute('data-citation', 'true')
  expect(screen.getByText('1 / 2')).toBeVisible()
  expect(screen.queryByRole('button', { name: '返回引用位置' })).toBeNull()
})
test('回复定位提示自动消退，保留报告证据和返回入口', async () => {
  render(<InsightSourceDialog {...props(vi.fn(async () => replySource('12')))} />)
  const link = await screen.findByRole('button', { name: /查看引用原消息/ })
  vi.useFakeTimers()
  try {
    fireEvent.click(link)
    const row = screen.getByText('原文12').closest('li')
    expect(row).toHaveClass('message-reference-target')
    act(() => vi.advanceTimersByTime(1800))
    expect(row).not.toHaveClass('message-reference-target')
    expect(screen.getByText('原文10').closest('li')).toHaveAttribute('data-citation', 'true')
    expect(screen.getByRole('button', { name: '返回引用位置' })).toBeEnabled()
  } finally { vi.useRealTimers() }
})
test('跨页原消息读取失败后可重试，切到下一段会丢弃迟到的定位结果', async () => {
  let finish!: (value: InsightCitationWindow) => void
  const p = props(vi.fn().mockResolvedValueOnce(replySource('90')).mockResolvedValueOnce(source(['30'], ['30'])))
  p.client.locateSource.mockResolvedValueOnce({ status: 'unavailable' }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<InsightSourceDialog {...p} />)
  fireEvent.click(await screen.findByRole('button', { name: /查看引用原消息/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('未找到原消息')
  expect(screen.getByText('原文11')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  fireEvent.click(screen.getByRole('button', { name: '下一段' }))
  await screen.findByText('原文30')
  await act(async () => { finish(source(['90'], ['90'])) })
  expect(screen.queryByText('原文90')).not.toBeInTheDocument()
  expect(screen.getByText('2 / 2')).toBeVisible()
  expect(screen.queryByRole('button', { name: '返回引用位置' })).toBeNull()
})
test('从跨页回复直接回到报告引用后仍能切换片段', async () => {
  const read = vi.fn().mockResolvedValueOnce(replySource('90')).mockResolvedValueOnce(replySource('90')).mockResolvedValueOnce(source(['30'], ['30']))
  const p = props(read)
  p.client.locateSource.mockResolvedValue(source(['90'], []))
  render(<InsightSourceDialog {...p} />)
  fireEvent.click(await screen.findByRole('button', { name: /查看引用原消息/ }))
  await screen.findByText('原文90')
  fireEvent.click(screen.getByRole('button', { name: '回到引用' }))
  expect(await screen.findByText('原文10')).toBeVisible()
  expect(screen.queryByRole('button', { name: '返回引用位置' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下一段' }))
  expect(await screen.findByText('原文30')).toBeVisible()
  expect(screen.getByText('2 / 2')).toBeVisible()
})
test('点击第二段引文直接定位原句，只标记这条来源消息中的引文', async () => {
  const window = source(['20', '21'], ['20', '21'])
  if (window.status !== 'available') throw Error('缺少测试原文')
  window.page.items[0].text = '我们周末再约，好吗？'
  window.page.items[1].text = '好呀，我们周末再约。'
  const read = vi.fn().mockResolvedValue(window)
  render(<InsightSourceDialog {...props(read)} initialFragmentIndex={1} quote="周末再约" quoteMessageId="21" />)
  expect(await screen.findByText('2 / 2')).toBeVisible()
  expect(read).toHaveBeenCalledWith({ taskId: '7', citationId: 'e1', fragmentIndex: 1, messageId: '21' })
  const region = screen.getByRole('region', { name: '引用聊天记录' })
  const mark = region.querySelector('mark')
  expect(mark).toHaveTextContent('周末再约')
  expect(mark?.closest('[data-message-id]')).toHaveAttribute('data-message-id', '21')
  expect(region.querySelector('[data-message-id="20"] mark')).toBeNull()

  Object.defineProperties(region, { clientHeight: { value: 300 }, scrollHeight: { value: 1500 } })
  vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  vi.spyOn(region.querySelector('[data-message-id="21"]')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -700, 400, 900))
  vi.spyOn(mark!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -690, 80, 20))
  fireEvent.scroll(region, { target: { scrollTop: 700 } })
  fireEvent.click(screen.getByRole('button', { name: '回到引用' }))
  expect(region).toHaveFocus()

  fireEvent.click(screen.getByRole('button', { name: '上一段' }))
  expect(await screen.findByText('1 / 2')).toBeVisible()
  expect(read).toHaveBeenLastCalledWith({ taskId: '7', citationId: 'e1', fragmentIndex: 0 })
  expect(region.querySelector('mark')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下一段' }))
  expect(await screen.findByText('2 / 2')).toBeVisible()
  expect(read).toHaveBeenLastCalledWith({ taskId: '7', citationId: 'e1', fragmentIndex: 1, messageId: '21' })
})
test('records the actual missing highlight separately from a successful citation read', async () => {
  const saved = window.whomi, conversation = vi.fn()
  window.whomi = { ...saved, operationDiagnostics: { conversation, importRefresh: vi.fn(), openInsightLog: vi.fn() } } as NonNullable<typeof saved>
  try {
    render(<InsightSourceDialog {...props(vi.fn(async () => source(['10'], ['99'])))} />)
    expect(await screen.findByText('原文10')).toBeVisible()
    await waitFor(() => expect(conversation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'end', outcome: 'failed' })))
    expect(conversation).toHaveBeenCalledWith(expect.objectContaining({ stage: 'read', count: 1 }))
    expect(conversation).toHaveBeenCalledWith(expect.objectContaining({ stage: 'display', found: false }))
    expect(JSON.stringify(conversation.mock.calls)).not.toContain('原文10')
  } finally { window.whomi = saved }
})
test('only exact evidence is highlighted, and a failed next fragment keeps the current text and number', async () => {
  const read = vi.fn().mockResolvedValueOnce(source()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(source(['30'], ['30']))
  render(<InsightSourceDialog {...props(read)} />)
  expect(await screen.findByText('原文10')).toBeInTheDocument()
  expect(screen.getByText('原文10').closest('li')).toHaveClass('message-source')
  expect(screen.getByText('原文11').closest('li')).not.toHaveClass('message-source')
  expect(screen.queryByRole('button', { name: '回到引用' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '上一段' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '下一段' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
  expect(screen.getByText('1 / 2')).toBeInTheDocument()
  expect(screen.getByText('原文10')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('原文30')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '引用聊天记录' })).toHaveFocus()
  expect(screen.getByText('2 / 2')).toBeInTheDocument()
  expect(read.mock.calls.map(call => call[0].fragmentIndex)).toEqual([0, 1, 1])
  expect(screen.getByRole('button', { name: '下一段' })).toBeDisabled()
})
test('scrolling pages locally without changing fragment index and does not request a finished direction again', async () => {
  const p = props()
  render(<InsightSourceDialog {...p} />)
  await screen.findByText('原文10')
  const region = screen.getByRole('region', { name: '引用聊天记录' })
  Object.defineProperties(region, { clientHeight: { value: 300 }, scrollHeight: { value: 900, configurable: true } })
  fireEvent.scroll(region, { target: { scrollTop: 10 } })
  await screen.findByText('原文9')
  expect(p.client.readMessages).toHaveBeenCalledWith({ conversationId: '9', cursor: 'before', direction: 'before' })
  fireEvent.scroll(region, { target: { scrollTop: 10 } })
  await waitFor(() => expect(p.client.readMessages).toHaveBeenCalledTimes(1))
  expect(screen.getByText('1 / 2')).toBeInTheDocument()
})
test('closing during the first read ignores late data and restores the existing trigger', async () => {
  let release!: (value: InsightCitationWindow) => void
  const p = props(vi.fn(() => new Promise<InsightCitationWindow>(resolve => { release = resolve })))
  const trigger = document.createElement('button'); document.body.append(trigger); p.returnFocus.current = trigger
  const page = render(<InsightSourceDialog {...p} />)
  expect(screen.queryByText('1 / 2')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭原文' }))
  expect(p.onClose).toHaveBeenCalledOnce()
  page.unmount()
  release(source())
  await waitFor(() => expect(screen.queryByText('原文10')).not.toBeInTheDocument())
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

test('a fragment jump takes priority over a pending context page and keeps keyboard focus in the new chat', async () => {
  let finishPage!: (page: Awaited<ReturnType<typeof p.client.readMessages>>) => void
  const read = vi.fn().mockResolvedValueOnce(source()).mockResolvedValueOnce(source(['30'], ['30']))
  const p = props(read)
  p.client.readMessages.mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve }))
  render(<InsightSourceDialog {...p} />)
  await screen.findByText('原文10')
  const region = screen.getByRole('region', { name: '引用聊天记录' })
  fireEvent.scroll(region, { target: { scrollTop: 0 } })
  expect(p.client.readMessages).toHaveBeenCalledOnce()
  const next = screen.getByRole('button', { name: '下一段' })
  expect(next).toBeEnabled()
  next.focus()
  fireEvent.click(next)
  await screen.findByText('原文30')
  expect(region).toHaveFocus()
  await act(async () => { finishPage({ items: [message('9')], beforeCursor: null, afterCursor: 'before', snapshotMaxId: '40' }) })
  expect(screen.queryByText('原文9')).not.toBeInTheDocument()
  expect(screen.getByText('原文30')).toBeInTheDocument()
  expect(screen.getByText('2 / 2')).toBeInTheDocument()
})

test('switching citations ignores a late fragment and clears the previous text and count', async () => {
  let finishJump!: (value: InsightCitationWindow) => void
  let finishCitation!: (value: InsightCitationWindow) => void
  const read = vi.fn().mockResolvedValueOnce(source())
    .mockImplementationOnce(() => new Promise(resolve => { finishJump = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { finishCitation = resolve }))
  const p = props(read)
  const view = render(<InsightSourceDialog {...p} />)
  await screen.findByText('原文10')
  const next = screen.getByRole('button', { name: '下一段' })
  fireEvent.click(next)
  fireEvent.click(next)
  expect(read).toHaveBeenCalledTimes(2)
  view.rerender(<InsightSourceDialog {...p} citationId="e2" phrase="另一次准备" />)
  expect(screen.queryByText('原文10')).not.toBeInTheDocument()
  expect(screen.queryByText('1 / 2')).not.toBeInTheDocument()
  await act(async () => { finishCitation(source(['40'], ['40'])) })
  await act(async () => { finishJump(source(['30'], ['30'])) })
  expect(screen.getByText('原文40')).toBeInTheDocument()
  expect(screen.queryByText('原文30')).not.toBeInTheDocument()
  expect(screen.getByText('1 / 2')).toBeInTheDocument()
})

test('returning to the current citation cancels a pending fragment jump and allows a new jump', async () => {
  let completeJump!: (value: InsightCitationWindow) => void
  const nextFragment = source(['30'], ['30'])
  const read = vi.fn().mockResolvedValueOnce(source())
    .mockImplementationOnce(() => new Promise(resolve => { completeJump = resolve }))
    .mockResolvedValueOnce(nextFragment)
  render(<InsightSourceDialog {...props(read)} />)
  await screen.findByText('原文10')
  const region = screen.getByRole('region', { name: '引用聊天记录' })
  Object.defineProperties(region, { clientHeight: { value: 300 }, scrollHeight: { value: 1500 } })
  vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  for (const row of region.querySelectorAll('[data-citation=true]')) {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -50, 400, 25))
  }
  fireEvent.scroll(region, { target: { scrollTop: 600 } })

  const next = screen.getByRole('button', { name: '下一段' })
  fireEvent.click(next)
  fireEvent.click(screen.getByRole('button', { name: '回到引用' }))
  await act(async () => { completeJump(nextFragment) })
  expect(screen.getByText('原文10')).toBeVisible()
  expect(screen.getByText('1 / 2')).toBeVisible()
  expect(screen.queryByText('原文30')).not.toBeInTheDocument()

  fireEvent.click(next)
  expect(await screen.findByText('原文30')).toBeVisible()
  expect(screen.getByText('2 / 2')).toBeVisible()
})
