import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { ConversationWorkspace } from '../workspace'
import type { ReferenceRange } from '../selection'
import type { ConversationAiAdapter, ConversationRequest, RestoredConversationTurn } from '../types'
import { ConversationAcceptancePendingError } from '../../../data/conversation-ai-client'
import { pasteComposerText } from '../../../test/cherry-composer-helpers'
import { writeComposerDraft } from './composer'

const saved = (request: ConversationRequest, eventSequence: number, text: string, state: RestoredConversationTurn['state'] = 'running'): RestoredConversationTurn => ({
  id: 'turn-1', requestId: request.requestId!, prompt: request.prompt, modelId: request.modelId,
  referenceIds: [], eventSequence, text, state,
})
const base = (): ConversationAiAdapter => ({ models: [{ id: 'm1', label: '模型甲' }], skills: [], respond: async () => ({ text: '' }), analyze: async () => {} })
function mount(adapter: ConversationAiAdapter, scope: string, clear = () => {}) {
  return render(<ConversationWorkspace conversationId={scope} title="示例聊天" references={[]} adapter={adapter}
    onClearReferences={clear} onJumpReference={() => {}}>{({ chatControl }) => chatControl}</ConversationWorkspace>)
}
function editor() { return screen.getByRole('textbox', { name: '向 AI 提问' }) }
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
}
async function send(user: ReturnType<typeof userEvent.setup>) {
  await pasteComposerText('第一条问题')
  await user.click(screen.getByRole('button', { name: '发送给 AI' }))
}

it('preserves newer text when the run observer delivers its initial snapshot after the thread watcher', async () => {
  const user = userEvent.setup(), adapter = base()
  let publish!: Parameters<NonNullable<ConversationAiAdapter['watchThread']>>[1]
  let request!: ConversationRequest, options!: Parameters<ConversationAiAdapter['respond']>[1]
  adapter.watchThread = async (_id, onChange) => { publish = onChange; onChange([]) }
  adapter.respond = (value, callbacks) => { request = value; options = callbacks; return new Promise(() => {}) }
  const clear = vi.fn()
  mount(adapter, 'review-older-stream', clear)
  await open(user)
  await send(user)
  await act(async () => publish([saved(request, 4, '最长且最新的正文')]))
  expect(screen.getByRole('log')).toHaveTextContent('最长且最新的正文')
  await act(async () => {
    options.onAccepted?.(saved(request, 1, '旧短正文'))
    options.onText('旧短正文')
  })
  expect(screen.getByRole('log')).toHaveTextContent('最长且最新的正文')
  expect(clear).toHaveBeenCalledTimes(1)
})

it('unlocks when the thread watcher receives a matching saved turn after failed readback', async () => {
  const user = userEvent.setup(), adapter = base()
  let publish!: Parameters<NonNullable<ConversationAiAdapter['watchThread']>>[1]
  let request!: ConversationRequest
  adapter.watchThread = async (_id, onChange) => { publish = onChange; onChange([]) }
  adapter.respond = async value => { request = value; throw new ConversationAcceptancePendingError(request.requestId!) }
  mount(adapter, 'review-accept-via-watch')
  await open(user)
  await send(user)
  expect(screen.getByRole('button', { name: '确认发送状态' })).toBeInTheDocument()
  await act(async () => publish([saved(request, 4, '已完成的回答', 'completed')]))
  expect(screen.getByRole('log')).toHaveTextContent('已完成的回答')
  expect(editor()).toHaveTextContent(/^$/)
  expect(screen.queryByRole('button', { name: '确认发送状态' })).not.toBeInTheDocument()
})

it('does not offer an already-saved draft for a new send after the reader remounts', async () => {
  const user = userEvent.setup(), adapter = base()
  let restored: RestoredConversationTurn | undefined, request!: ConversationRequest
  let finish!: (value: { text: string }) => void
  adapter.restoreThread = async () => restored ? [restored] : []
  adapter.respond = vi.fn(value => { request = value; return new Promise<{ text: string }>(resolve => { finish = resolve }) })
  const first = mount(adapter, 'review-accept-after-remount')
  await open(user)
  await send(user)
  first.unmount()
  restored = saved(request, 4, '离开期间完成的回答', 'completed')
  await act(async () => finish({ text: restored!.text }))
  mount(adapter, 'review-accept-after-remount')
  await open(user)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('离开期间完成的回答'))
  expect(screen.getByRole('button', { name: '发送给 AI' })).toHaveAttribute('aria-disabled', 'true')
})

it('preserves the saved partial answer if the backend rejects a retry before acceptance', async () => {
  const user = userEvent.setup(), adapter = base()
  adapter.restoreThread = async () => [{ id: 'turn-1', requestId: 'original', prompt: '先前的提问', modelId: 'm1',
    referenceIds: [], eventSequence: 3, text: '已保存的半段回答', state: 'stopped' }]
  adapter.respond = vi.fn(async () => { throw new Error('模型已更改，请重新提问。') })
  mount(adapter, 'review-retry-rejected')
  await open(user)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('已保存的半段回答'))
  await user.click(screen.getByRole('button', { name: '重试回答' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('模型已更改')
  expect(screen.getByRole('log')).toHaveTextContent('已保存的半段回答')
})

it('restores the existing thread draft instead of replacing it with the empty initial scope', async () => {
  const user = userEvent.setup(), adapter = base()
  writeComposerDraft('review-existing-draft:thread-a', '已在线程里写的草稿')
  adapter.listThreads = async () => [{ id: 'thread-a', conversationId: 'review-existing-draft', title: '已有对话', createdAtMs: 0, updatedAtMs: 0 }]
  adapter.restoreThread = async () => []
  mount(adapter, 'review-existing-draft')
  await open(user)
  await waitFor(() => expect(editor()).toHaveTextContent('已在线程里写的草稿'))
})

it('confirms an uncertain retry by reading storage without starting another attempt', async () => {
  const user = userEvent.setup(), adapter = base()
  const original: RestoredConversationTurn = { id: 'turn-retry', requestId: 'retry-confirm-request', prompt: '原问题',
    modelId: 'm1', referenceIds: [], text: '已保存的部分', state: 'stopped', eventSequence: 3 }
  let snapshot = original
  adapter.restoreThread = async () => [snapshot]
  adapter.respond = vi.fn(async request => { throw new ConversationAcceptancePendingError(request.requestId!) })
  mount(adapter, 'review-confirm-retry')
  await open(user)
  await user.click(await screen.findByRole('button', { name: '重试回答' }))
  snapshot = { ...original, eventSequence: 6, state: 'failed', error: '本次连接失败' }
  await user.click(await screen.findByRole('button', { name: '确认发送状态' }))
  expect(adapter.respond).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('本次连接失败'))
})

it('preserves the next draft when a retry is confirmed after remount', async () => {
  const user = userEvent.setup(), adapter = base(), clear = vi.fn()
  const original: RestoredConversationTurn = { id: 'held-retry', requestId: 'held-retry-request', prompt: '原问题',
    modelId: 'm1', referenceIds: [], text: '先前保存的部分', state: 'stopped', eventSequence: 3, attempt: 1 }
  let snapshot = original
  adapter.restoreThread = async () => [snapshot]
  adapter.respond = vi.fn(async request => { throw new ConversationAcceptancePendingError(request.requestId!) })
  const first = mount(adapter, 'review-held-retry', clear)
  await open(user)
  await pasteComposerText('下一条草稿乙')
  await user.click(await screen.findByRole('button', { name: '重试回答' }))
  await screen.findByRole('button', { name: '确认发送状态' })
  first.unmount()
  mount(adapter, 'review-held-retry', clear)
  await open(user)
  await waitFor(() => expect(editor()).toHaveTextContent('下一条草稿乙'))
  snapshot = { ...original, eventSequence: 6, attempt: 2, state: 'completed', text: '重试已经完成' }
  await user.click(await screen.findByRole('button', { name: '确认发送状态' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('重试已经完成'))
  expect(editor()).toHaveTextContent('下一条草稿乙')
  expect(clear).not.toHaveBeenCalled()
  expect(adapter.respond).toHaveBeenCalledTimes(1)
})

it('preserves selected references when opening an existing thread with an empty initial draft', async () => {
  const user = userEvent.setup(), adapter = base()
  const conversationId = 'review-existing-thread-with-references'
  const originalReferences: readonly ReferenceRange[] = [{
    id: '9',
    messages: [{
      id: '9', conversationId, memberId: '1', senderKind: 'member', senderName: '示例成员', isSelf: true,
      sentAtMs: null, timeRaw: null, timePrecision: 'unknown', timezone: null, timeBucket: 1, sortTime: 1,
      ordinal: 0, kind: 'text', sourceType: null, text: '明晚九点我听你讲', reply: null, attachments: [],
    }],
  }]
  adapter.listThreads = async () => [{ id: 'thread-a', conversationId, title: '已有对话', createdAtMs: 0, updatedAtMs: 0 }]
  adapter.restoreThread = vi.fn(async () => [])
  adapter.respond = vi.fn(async () => ({ text: '本轮回答' }))
  function Fixture() {
    const [references, setReferences] = useState(originalReferences)
    return <ConversationWorkspace conversationId={conversationId} title="示例聊天" references={references}
      adapter={adapter} onRestoreReferences={setReferences} onClearReferences={() => setReferences([])}
      onJumpReference={() => {}}>{({ chatControl }) => chatControl}</ConversationWorkspace>
  }
  render(<Fixture />)
  await open(user)
  await waitFor(() => expect(adapter.restoreThread).toHaveBeenCalledWith(conversationId, 'thread-a'))
  expect(editor()).toHaveTextContent(/^$/)
  await send(user)
  expect(adapter.respond).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ threadId: 'thread-a', prompt: '第一条问题', references: originalReferences }),
    expect.anything(),
  )
})
