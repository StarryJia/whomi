import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ConversationAcceptancePendingError, ConversationTurnError } from '../../data/conversation-ai-client'
import { clearFixtureDrafts, pasteComposerText, persistedTurn } from '../../test/cherry-composer-helpers'
import { ExceptionNoticeProvider } from '../ui/exception-notices'
import type { ConversationAiAdapter, RestoredConversationTurn } from './types'
import { ConversationWorkspace } from './workspace'

function showChat(adapter: Pick<ConversationAiAdapter, 'respond' | 'watchThread' | 'restoreThread'>) {
  clearFixtureDrafts('example')
  return render(<ExceptionNoticeProvider><ConversationWorkspace conversationId="example" title="示例会话" references={[]}
    adapter={{ models: [{ id: 'one', label: '示例模型' }], skills: [], analyze: async () => {}, ...adapter }}
    onClearReferences={() => {}} onJumpReference={() => {}}>
    {({ chatControl }) => chatControl}
  </ConversationWorkspace></ExceptionNoticeProvider>)
}

const notices = () => screen.queryByRole('region', { name: '异常提醒' })

it('受理后先收到失败快照就可查看提醒，同一失败的最终回执不会再次提醒', async () => {
  const user = userEvent.setup()
  let failSnapshot!: () => void
  let finish!: () => void
  const respond: ConversationAiAdapter['respond'] = (request, { onAccepted, onSnapshot }) => {
    const turn = persistedTurn(request, { state: 'running', attempt: 1, eventSequence: 1 })
    onAccepted?.(turn)
    const failed: RestoredConversationTurn = { ...turn, state: 'failed', eventSequence: 2, error: '连接失败' }
    failSnapshot = () => onSnapshot?.(failed)
    return new Promise((_resolve, reject) => { finish = () => reject(new ConversationTurnError(failed)) })
  }
  showChat({ respond })
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await pasteComposerText('先检查本轮状态')
  await user.click(screen.getByRole('button', { name: '发送给 AI' }))
  await act(async () => failSnapshot())
  expect(await within(screen.getByRole('log')).findByRole('alert')).toHaveTextContent('连接失败')
  const notice = within(await screen.findByRole('region', { name: '异常提醒' }))
  await user.click(notice.getByRole('button', { name: '关闭提醒' }))
  await act(async () => finish())
  expect(notices()).not.toBeInTheDocument()
  expect(await within(screen.getByRole('log')).findByRole('button', { name: '重试回答' })).toBeEnabled()
})

it('已受理的回答失败时在顶部提醒，重试仍在原消息内，重试失败可再提醒', async () => {
  const user = userEvent.setup()
  let attempts = 0
  const respond: ConversationAiAdapter['respond'] = async request => {
    if (++attempts < 3) throw new ConversationTurnError(persistedTurn(request, { state: 'failed', error: '连接失败' }))
    return { text: '重试后的回答' }
  }
  showChat({ respond })
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await pasteComposerText('示例问题')
  await user.click(screen.getByRole('button', { name: '发送给 AI' }))
  const log = within(screen.getByRole('log'))
  expect(await log.findByRole('alert')).toHaveTextContent('连接失败')
  const notice = within(await screen.findByRole('region', { name: '异常提醒' }))
  expect(notice.getAllByRole('alert')).toHaveLength(1)
  await user.click(notice.getByRole('button', { name: '展开详情' }))
  expect(notice.getByText('连接失败')).toBeVisible()
  await user.click(notice.getByRole('button', { name: '关闭提醒' }))
  expect(notices()).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '关闭 AI 对话' }))
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  expect(notices()).not.toBeInTheDocument()
  const retry = () => within(screen.getByRole('log')).findByRole('button', { name: '重试回答' })
  await user.click(await retry())
  expect(within(await screen.findByRole('region', { name: '异常提醒' })).getAllByRole('alert')).toHaveLength(1)
  await user.click(await retry())
  expect(await within(screen.getByRole('log')).findByText('重试后的回答')).toBeVisible()
  expect(notices()).not.toBeInTheDocument()
  expect(within(screen.getByRole('log')).getAllByText('示例问题')).toHaveLength(1)
})

it('读取历史失败时仅显示原消息，正在观察的回答随后失败只提醒一次', async () => {
  const user = userEvent.setup()
  let update!: (turns: RestoredConversationTurn[]) => void
  const saved: RestoredConversationTurn = {
    id: '1', requestId: 'prior', prompt: '先前的问题', referenceIds: [], modelId: 'one',
    text: '', state: 'failed', attempt: 1, eventSequence: 4, error: '旧连接已断开',
  }
  const running: RestoredConversationTurn = { ...saved, id: '2', requestId: 'live', prompt: '正在回答的问题',
    state: 'running', error: undefined, eventSequence: 2 }
  const watchThread: NonNullable<ConversationAiAdapter['watchThread']> = async (_id, receive) => {
    update = receive
    receive([saved, running])
  }
  showChat({ respond: vi.fn(), watchThread })
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  expect(await within(screen.getByRole('log')).findByRole('alert')).toHaveTextContent(saved.error!)
  expect(notices()).not.toBeInTheDocument()
  const failed: RestoredConversationTurn = { ...running, state: 'failed', error: '本轮连接失败', eventSequence: 3 }
  await act(async () => update([saved, failed]))
  const notice = within(await screen.findByRole('region', { name: '异常提醒' }))
  await user.click(notice.getByRole('button', { name: '展开详情' }))
  expect(notice.getByText('本轮连接失败')).toBeVisible()
  await user.click(notice.getByRole('button', { name: '关闭提醒' }))
  await act(async () => update([saved, { ...failed, eventSequence: 4, usage: { outputTokens: 10 } }]))
  expect(notices()).not.toBeInTheDocument()
})

it('重访后主动核对未确认的重试，读到新一次失败仍提供本轮提醒', async () => {
  const user = userEvent.setup()
  let saved: RestoredConversationTurn = { id: 'held', requestId: 'retry-readback', prompt: '原问题',
    modelId: 'one', referenceIds: [], text: '', state: 'failed', attempt: 1, eventSequence: 3, error: '先前的失败' }
  const adapter = { restoreThread: async () => [saved], respond: async () => { throw new ConversationAcceptancePendingError(saved.requestId) } }
  const first = showChat(adapter)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await user.click(await within(screen.getByRole('log')).findByRole('button', { name: '重试回答' }))
  expect(await screen.findByRole('button', { name: '确认发送状态' })).toBeEnabled()
  first.unmount()
  showChat(adapter)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  const confirm = await screen.findByRole('button', { name: '确认发送状态' })
  saved = { ...saved, attempt: 2, eventSequence: 6, error: '本轮连接失败' }
  await user.click(confirm)
  expect(await within(screen.getByRole('log')).findByRole('alert')).toHaveTextContent('本轮连接失败')
  const notice = within(await screen.findByRole('region', { name: '异常提醒' }))
  await user.click(notice.getByRole('button', { name: '展开详情' }))
  expect(notice.getByText('本轮连接失败')).toBeVisible()
})
