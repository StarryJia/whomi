import { clearFixtureDrafts, composerTextbox, expectComposerText, pasteComposerText } from '../../test/cherry-composer-helpers'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AiThread } from '../../shared/ai-contract'
import type { ConversationAiAdapter, RestoredConversationTurn } from './types'
import { ConversationWorkspace } from './workspace'

beforeEach(() => clearFixtureDrafts('chat', ['first', 'new']))

function mount(restoreThread: NonNullable<ConversationAiAdapter['restoreThread']>, hasCurrent: boolean) {
  const thread: AiThread = { id: 'first', conversationId: 'chat', title: '新对话', createdAtMs: 1, updatedAtMs: 1, turns: [] }
  const createThread = vi.fn(async () => ({ ...thread, id: 'new' }))
  const adapter: ConversationAiAdapter = {
    models: [{ id: 'm', label: '示例模型' }], skills: [], analyze: async () => {}, respond: async () => ({ text: '示例回答' }),
    listThreads: async () => hasCurrent ? [thread] : [], createThread, restoreThread,
  }
  render(<ConversationWorkspace conversationId="chat" title="示例" adapter={adapter} references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}}>
    {({ chatControl }) => chatControl}
  </ConversationWorkspace>)
  return createThread
}

it('再次新建时复用当前空对话并聚焦已有草稿', async () => {
  const user = userEvent.setup()
  const create = mount(async () => [], false)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  const newChat = screen.getByRole('button', { name: '新建 AI 对话' })
  await user.click(newChat)
  await pasteComposerText('待发送的问题')
  const editor = await composerTextbox()
  await user.click(newChat)
  expect(create).toHaveBeenCalledTimes(1)
  await expectComposerText('待发送的问题')
  await vi.waitFor(() => expect(editor).toHaveFocus())
})

it('等历史恢复后按已发送轮次判断，即使对话仍叫新对话也可另开', async () => {
  const user = userEvent.setup()
  let resolve!: (turns: RestoredConversationTurn[]) => void
  const create = mount(async (_conversation, id) => id === 'first' ? new Promise<RestoredConversationTurn[]>(done => { resolve = done }) : [], true)
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await screen.findByText('正在恢复对话…')
  const button = screen.getByRole('button', { name: '新建 AI 对话' })
  expect(button).toBeDisabled()
  await act(async () => resolve([{ id: '1', requestId: 'r', referenceIds: [], prompt: '新对话', modelId: 'm', state: 'failed', text: '' }]))
  await user.click(button)
  expect(create).toHaveBeenCalledTimes(1)
})
