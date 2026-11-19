import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
function props(readCitation = vi.fn(async () => source())) {
  return { taskId: '7', citationId: 'e1', phrase: '那次准备', conversationTitle: '小林', onClose: vi.fn(), returnFocus: createRef<HTMLButtonElement>(), fragmentCount: 2,
    readCitation, client: { locateSource: vi.fn(), readMessages: vi.fn(async (input: { limit?: number }) => {
      if (input.limit !== undefined && input.limit !== 100) throw new Error('INVALID_CURSOR')
      return { items: [message('9')], beforeCursor: null, afterCursor: 'before', snapshotMaxId: '40' }
    }) } }
}
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
  fireEvent.click(screen.getByRole('button', { name: '关闭原文' }))
  expect(p.onClose).toHaveBeenCalledOnce()
  page.unmount()
  release(source())
  await waitFor(() => expect(screen.queryByText('原文10')).not.toBeInTheDocument())
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
