import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationWorkspace } from '../workspace'
import type { ConversationAiAdapter, ConversationRequest, RestoredConversationTurn } from '../types'
import type { ReferenceRange } from '../selection'
import { ConversationAcceptancePendingError } from '../../../data/conversation-ai-client'
import { readComposerDraft } from './composer'
import { pasteComposerText } from '../../../test/cherry-composer-helpers'

const refs: ReferenceRange[] = [{ id: 'range', messages: [{ id: '9', text: '示例原文', senderName: '示例成员',
  conversationId: 'example', memberId: null, senderKind: 'member', isSelf: false, sentAtMs: null, timeRaw: null,
  timePrecision: 'unknown', timezone: null, timeBucket: 1, sortTime: 0, ordinal: 0, kind: 'text', sourceType: null,
  reply: null, attachments: [] }] }]
function saved(request: ConversationRequest, state: RestoredConversationTurn['state'] = 'running'): RestoredConversationTurn {
  return { id: 'turn-1', requestId: request.requestId!, prompt: request.prompt, modelId: request.modelId,
    referenceIds: ['9'], text: '', state }
}
function editorText() {
  const editor = screen.getByRole('textbox', { name: '向 AI 提问' })
  return editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent
}
async function enter(text: string) {
  await pasteComposerText(text)
}
function Fixture({ client, scope }: { client: ConversationAiAdapter; scope: string }) {
  const [references, setReferences] = useState<readonly ReferenceRange[]>(refs)
  return <ConversationWorkspace conversationId={scope} title="示例聊天" references={references} adapter={client}
    onClearReferences={() => setReferences([])} onRestoreReferences={setReferences} onJumpReference={() => {}}>
    {({ chatControl }) => chatControl}
  </ConversationWorkspace>
}
function client(): ConversationAiAdapter {
  return { models: [{ id: 'm1', label: '模型甲' }, { id: 'm2', label: '模型乙' }], skills: [],
    respond: async () => ({ text: '示例回答' }), analyze: async () => {} }
}
describe('正式工作区的受理交接', () => {
  it('受理之前保留草稿与引用，受理后且首字之前开放下一条草稿', async () => {
    const user = userEvent.setup(), api = client()
    let request!: ConversationRequest, options!: Parameters<ConversationAiAdapter['respond']>[1]
    let finish!: (result: { text: string }) => void
    api.respond = vi.fn((r, o) => { request = r; options = o; return new Promise<{ text: string }>(resolve => { finish = resolve }) })
    render(<Fixture client={api} scope="accepted-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('第一条问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(editorText()).toBe('第一条问题')
    expect(screen.getByRole('button', { name: '清空全部引用' })).toBeDisabled()
    await act(async () => options.onAccepted?.(saved(request)))
    await waitFor(() => expect(editorText()).toBe(''))
    expect(screen.queryByRole('button', { name: '清空全部引用' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '对话模型' })).not.toBeDisabled()
    await enter('下一条草稿')
    fireEvent.keyDown(screen.getByRole('textbox', { name: '向 AI 提问' }), { key: 'Enter' })
    expect(api.respond).toHaveBeenCalledTimes(1)
    await act(async () => finish({ text: '第一条回答' }))
    expect(editorText()).toBe('下一条草稿')
  })
  it('未受理的错误保留原稿和引用，不制造可重试的历史轮次', async () => {
    const user = userEvent.setup(), api = client()
    api.respond = vi.fn(async () => { throw new Error('模型不可用，请选择模型。') })
    render(<Fixture client={api} scope="rejected-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('尚未保存的问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型不可用')
    expect(editorText()).toBe('尚未保存的问题')
    expect(screen.getByRole('button', { name: '清空全部引用' })).not.toBeDisabled()
    expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument()
  })
  it('已完成的空回答提示重新提问，不改成失败轮次', async () => {
    const user = userEvent.setup(), api = client()
    api.respond = async (request, options) => {
      const turn = saved(request, 'completed')
      options.onAccepted?.(turn)
      return { text: '', turn }
    }
    render(<Fixture client={api} scope="empty-completed-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('空回答示例')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument())
    expect(screen.getByRole('log')).toHaveTextContent('重新提问')
  })
  it('首次建线程后在受理前保留原编辑器，首轮历史转入正式线程', async () => {
    const user = userEvent.setup(), api = client()
    let create!: (value: Awaited<ReturnType<NonNullable<ConversationAiAdapter['createThread']>>>) => void
    api.createThread = () => new Promise(resolve => { create = resolve })
    let request!: ConversationRequest, options!: Parameters<ConversationAiAdapter['respond']>[1]
    api.respond = (r, o) => { request = r; options = o; return new Promise(() => {}) }
    render(<Fixture client={api} scope="first-thread-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('首次问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(editorText()).toBe('首次问题')
    await act(async () => create({ id: 'thread-a', conversationId: 'first-thread-boundary', title: '新对话',
      pinned: false, createdAtMs: 0, updatedAtMs: 0, turns: [] }))
    expect(editorText()).toBe('首次问题')
    await act(async () => options.onAccepted?.(saved(request)))
    await waitFor(() => expect(editorText()).toBe(''))
    await enter('正式线程草稿')
    expect(readComposerDraft('first-thread-boundary:thread-a')).toBe('正式线程草稿')
    expect(readComposerDraft('first-thread-boundary:initial')).toBe('')
  })
  it('发送待确认时保留原请求编号与草稿，确认不会另建一轮', async () => {
    const user = userEvent.setup(), api = client(), requests: ConversationRequest[] = []
    api.respond = async (request, options) => {
      requests.push(request)
      if (requests.length === 1) throw new ConversationAcceptancePendingError(request.requestId!)
      const turn = saved(request, 'completed')
      options.onAccepted?.(turn)
      return { text: '确认的回答', turn: { ...turn, text: '确认的回答' } }
    }
    render(<Fixture client={api} scope="pending-acceptance-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('已提交待确认')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(editorText()).toBe('已提交待确认')
    expect(screen.getByRole('button', { name: '清空全部引用' })).toBeDisabled()
    await user.click(await screen.findByRole('button', { name: '确认发送状态' }))
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    await waitFor(() => expect(editorText()).toBe(''))
    expect(screen.getByRole('log')).toHaveTextContent('确认的回答')
  })
  it('观察者迟到的旧快照不覆盖已受理的新正文', async () => {
    const user = userEvent.setup(), api = client()
    let receive!: Parameters<NonNullable<ConversationAiAdapter['watchThread']>>[1]
    api.watchThread = async (_id, onChange) => { receive = onChange; onChange([]) }
    let request!: ConversationRequest
    api.respond = async (value, options) => {
      request = value
      options.onAccepted?.({ ...saved(value), text: '最新正文', eventSequence: 4 })
      return new Promise(() => {})
    }
    render(<Fixture client={api} scope="stale-snapshot-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('快照示例')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await act(async () => receive([{ ...saved(request), text: '旧正文', eventSequence: 2 }]))
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('最新正文'))
    expect(screen.getByRole('log')).not.toHaveTextContent('旧正文')
  })
  it('恢复没有错误详情的中断轮次时显示中断并允许末轮重试', async () => {
    const user = userEvent.setup(), api = client()
    api.restoreThread = async () => [{ id: 'interrupted-1', requestId: 'interrupted-request',
      prompt: '重启前的问题', referenceIds: [], modelId: 'm1', text: '已经保存的部分', state: 'interrupted' }]
    render(<Fixture client={api} scope="interrupted-restoration" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('回答中断'))
    expect(screen.getByRole('log')).toHaveTextContent('已经保存的部分')
    expect(screen.getByRole('button', { name: '重试回答' })).toBeInTheDocument()
  })
  it('待确认后核实未受理时解除确认状态，保留草稿供修改重发', async () => {
    const user = userEvent.setup(), api = client()
    let calls = 0
    api.respond = async request => {
      if (++calls === 1) throw new ConversationAcceptancePendingError(request.requestId!)
      throw new Error('模型不可用，请选择模型。')
    }
    render(<Fixture client={api} scope="pending-rejected-boundary" />)
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await enter('尚未受理的草稿')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await user.click(await screen.findByRole('button', { name: '确认发送状态' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认发送状态' })).not.toBeInTheDocument())
    expect(editorText()).toBe('尚未受理的草稿')
    expect(screen.getByRole('combobox', { name: '对话模型' })).not.toBeDisabled()
  })
})
