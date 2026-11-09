import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ConversationAcceptancePendingError, createConversationAiClient, isConversationNotSubmitted } from '../../../data/conversation-ai-client'
import type { AiApi, AiEvent, AiModel, AiThread, AiTurn } from '../../../shared/ai-contract'
import { expectComposerText, pasteComposerText } from '../../../test/cherry-composer-helpers'
import type { ConversationAiAdapter, RestoredConversationTurn } from '../types'
import { ConversationWorkspace } from '../workspace'

const draft = '我想补充当时的背景'
const previousAnswer = '已保存的半段回答'
const model: AiModel = { id: 'model', label: '示例模型', model: 'example', baseUrl: 'https://example.test/v1',
  contextWindow: 8192, maxTokens: 1024, version: 1, enabled: true, hasCredential: true }

async function setup(conversationId: string) {
  const thread: AiThread = { id: 'thread', conversationId, title: '已有对话', createdAtMs: 1, updatedAtMs: 1, turns: [{
    id: 'turn', threadId: 'thread', requestId: 'original-request', prompt: '原问题', referenceIds: [],
    modelId: model.id, text: previousAnswer, state: 'stopped', attempt: 1, usage: {}, eventSequence: 3,
  }] }
  const listeners = new Set<(event: AiEvent) => void>()
  const transport = {
    listModels: async () => [model],
    listSkills: async () => [],
    listThreads: async () => [thread],
    getThread: vi.fn<AiApi['getThread']>(async () => thread),
    retryTurn: vi.fn<AiApi['retryTurn']>(),
    stopTurn: vi.fn<AiApi['stopTurn']>(),
    onEvent: (listener: (event: AiEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } satisfies Partial<AiApi>
  const adapter = await createConversationAiClient(transport as unknown as AiApi)
  const respond = vi.spyOn(adapter, 'respond')
  const user = userEvent.setup()
  async function open() {
    const view = render(<ConversationWorkspace conversationId={conversationId} title="示例聊天" references={[]}
      adapter={adapter} onClearReferences={() => {}} onJumpReference={() => {}}>
      {({ chatControl }) => chatControl}
    </ConversationWorkspace>)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    return view
  }
  function startRetry() {
    let releaseRead!: (value: AiThread) => void
    transport.getThread.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '重试回答' }))
    expect(respond).toHaveBeenCalledTimes(1)
    expect(releaseRead).toBeTypeOf('function')
    return async () => {
      await act(async () => {
        releaseRead(thread)
        await expect(respond.mock.results[0].value).rejects.toSatisfy(isConversationNotSubmitted)
      })
      expect(transport.retryTurn).not.toHaveBeenCalled()
      expect(transport.stopTurn).not.toHaveBeenCalled()
    }
  }
  return { open, startRetry, thread, transport, respond, emit: (event: AiEvent) => listeners.forEach(listener => listener(event)) }
}

async function expectReady() {
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(previousAnswer))
  await expectComposerText(draft)
  expect(screen.queryByRole('button', { name: '确认发送状态' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试回答' })).toBeInTheDocument()
  await pasteComposerText('下一条问题仍可编辑', { replace: true })
  await expectComposerText('下一条问题仍可编辑')
}

it('restores the saved turn and unlocks the next draft when stopped before submitting a retry', async () => {
  const { open, startRetry } = await setup('retry-cancel-before-submit')
  await open()
  await screen.findByRole('button', { name: '重试回答' })
  await pasteComposerText(draft)
  const finishRead = startRetry()
  fireEvent.click(screen.getByRole('button', { name: '停止回答' }))
  await finishRead()
  await expectReady()
})

it('reopens an editable draft when leaving before the retry is submitted', async () => {
  const { open, startRetry } = await setup('retry-detach-before-submit')
  const first = await open()
  await screen.findByRole('button', { name: '重试回答' })
  await pasteComposerText(draft)
  const finishRead = startRetry()
  first.unmount()
  await finishRead()
  await open()
  await expectReady()
})

it('unlocks the remounted workspace when the earlier retry preflight finishes later', async () => {
  const { open, startRetry } = await setup('retry-remount-before-preflight')
  const first = await open()
  await screen.findByRole('button', { name: '重试回答' })
  await pasteComposerText(draft)
  const finishRead = startRetry()
  first.unmount()

  await open()
  await screen.findByRole('button', { name: '确认发送状态' })
  await finishRead()
  await expectReady()
})

it('stops a saved retry once when the stop preceded a lost acknowledgement and failed readback', async () => {
  const { open, thread, transport, respond, emit } = await setup('retry-stop-without-acknowledgement')
  const running: AiTurn = { ...thread.turns[0], state: 'running', attempt: 2, eventSequence: 4, text: '本次已保存的部分' }
  const stopped: AiTurn = { ...running, state: 'stopped', eventSequence: 5 }
  let rejectReply!: (error: Error) => void
  transport.retryTurn.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectReply = reject }))
  transport.stopTurn.mockImplementation(async () => {
    transport.getThread.mockResolvedValue({ ...thread, turns: [stopped] })
    emit({ kind: 'turn', snapshot: stopped })
    return stopped
  })

  await open()
  await screen.findByRole('button', { name: '重试回答' })
  await pasteComposerText(draft)
  fireEvent.click(screen.getByRole('button', { name: '重试回答' }))
  await waitFor(() => expect(transport.retryTurn).toHaveBeenCalledExactlyOnceWith('turn'))
  fireEvent.click(screen.getByRole('button', { name: '停止回答' }))
  transport.getThread.mockRejectedValueOnce(new Error('重试回查暂时失败'))
  await act(async () => {
    rejectReply(new Error('未收到重试回执'))
    await expect(respond.mock.results[0].value).rejects.toMatchObject({ stopRequested: true })
  })

  await act(async () => emit({ kind: 'turn', snapshot: running }))
  await waitFor(() => expect(transport.stopTurn).toHaveBeenCalledExactlyOnceWith('turn'))
  expect(transport.retryTurn).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('本次已保存的部分'))
  await screen.findByRole('button', { name: '重试回答' })
  await expectComposerText(draft)
})

it('does not carry an in-flight confirmation into another thread after a watcher accepts the first retry', async () => {
  const scope = 'retry-confirmation-thread-change'
  const user = userEvent.setup()
  const threads = ['甲', '乙'].map(label => ({ id: label, conversationId: scope, title: '对话' + label, createdAtMs: 1, updatedAtMs: 1 }))
  const initial = (label: string): RestoredConversationTurn => ({ id: 'turn-' + label, requestId: 'request-' + label,
    prompt: '原问题' + label, referenceIds: [], modelId: 'model', state: 'stopped', text: '原回答' + label, attempt: 1, eventSequence: 3 })
  const watches = new Map<string, (turns: RestoredConversationTurn[]) => void>()
  let finishRead!: (turns: RestoredConversationTurn[]) => void
  const adapter: ConversationAiAdapter = {
    models: [model], skills: [],
    listThreads: async () => threads,
    watchThread: async (_conversationId, receive, _signal, id) => {
      watches.set(id!, receive)
      receive([initial(id!)])
    },
    restoreThread: () => new Promise(resolve => { finishRead = resolve }),
    respond: async request => { throw new ConversationAcceptancePendingError(request.requestId!) },
    analyze: async () => {},
  }
  render(<ConversationWorkspace conversationId={scope} title="示例聊天" references={[]} adapter={adapter}
    onClearReferences={() => {}} onJumpReference={() => {}}>{({ chatControl }) => chatControl}</ConversationWorkspace>)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await user.click(await screen.findByRole('button', { name: '重试回答' }))
  const confirmA = await screen.findByRole('button', { name: '确认发送状态' })
  await user.click(confirmA)
  expect(confirmA).toBeDisabled()

  const completed: RestoredConversationTurn = { ...initial('甲'), state: 'completed', text: '甲重试完成', attempt: 2, eventSequence: 6 }
  await act(async () => watches.get('甲')!([completed]))
  await user.click(screen.getByRole('button', { name: '显示对话列表' }))
  await user.click(screen.getByRole('button', { name: '对话乙' }))
  await act(async () => finishRead([completed]))
  await user.click(await screen.findByRole('button', { name: '重试回答' }))
  expect(await screen.findByRole('button', { name: '确认发送状态' })).toBeEnabled()
})
