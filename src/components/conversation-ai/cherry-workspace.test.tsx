import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { ConversationWorkspace } from './workspace'
import type { ConversationAiAdapter } from './types'
import type { ReferenceRange } from './selection'

function adapter(): ConversationAiAdapter {
  return { models: [{ id: 'one', label: '同名模型', providerId: 'a', providerName: '示例服务 A', model: 'model-a' },
    { id: 'two', label: '同名模型', providerId: 'b', providerName: '示例服务 B', model: 'model-b' }], skills: [],
    respond: async () => ({ text: '示例回答' }), analyze: async () => {} } as ConversationAiAdapter
}
function Fixture({ client, initialReferences = [] }: { client: ConversationAiAdapter; initialReferences?: ReferenceRange[] }) {
  const [references, setReferences] = useState(initialReferences)
  return <ConversationWorkspace conversationId="example" title="不需要重复的会话名" references={references}
    onClearReferences={() => setReferences([])} onJumpReference={() => {}} adapter={client}>
    {({ composer }) => <section aria-label="原文区域">{composer}</section>}
  </ConversationWorkspace>
}

describe('Cherry 对话流程接入', () => {
  it('技能菜单的 Escape 只关闭菜单，焦点回到技能入口', async () => {
    const user = userEvent.setup(), client = adapter()
    client.skills = [{ id: 'review', label: '沟通复盘' }]
    function SkillFixture() {
      const [references, setReferences] = useState<ReferenceRange[]>([])
      return <ConversationWorkspace conversationId="example" title="示例会话" references={references} adapter={client}
        onClearReferences={() => setReferences([])} onJumpReference={() => {}}>
        {({ composer }) => <section><button onClick={() => setReferences([{ id: 'r', messages: [] }])}>引用示例</button>{composer}</section>}
      </ConversationWorkspace>
    }
    render(<SkillFixture />)
    await user.type(screen.getByRole('textbox'), '示例问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await screen.findByText('示例回答')
    await user.click(screen.getByRole('button', { name: '引用示例' }))
    act(() => screen.getByRole('combobox', { name: '对话技能' }).focus())
    await user.keyboard('{Enter}')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('complementary', { name: 'AI 对话' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: '对话技能' })).toHaveFocus()
  })
  it('提交后交接草稿，回答完成不会清掉新输入的相同问题', async () => {
    const user = userEvent.setup(), client = adapter()
    let finish!: (value: { text: string }) => void
    client.respond = () => new Promise(resolve => { finish = resolve })
    render(<Fixture client={client} />)
    await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '示例问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '示例问题')
    await act(async () => finish({ text: '本轮回答' }))
    expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toHaveValue('示例问题')
    expect(screen.getByRole('log')).toHaveTextContent('本轮回答')
  })

  it('失败重试使用原请求快照，保留后续草稿且不重复提问', async () => {
    const user = userEvent.setup(), client = adapter()
    const requests: string[] = []
    client.respond = async request => { requests.push(request.prompt); if (requests.length === 1) throw new Error('连接失败'); return { text: '重试成功' } }
    render(<Fixture client={client} />)
    await user.type(screen.getByRole('textbox'), '第一条')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('连接失败')
    expect(screen.getByRole('textbox')).toHaveValue('')
    await user.type(screen.getByRole('textbox'), '第二条草稿')
    await user.click(screen.getByRole('button', { name: '重试回答' }))
    expect(await screen.findByText('重试成功')).toBeInTheDocument()
    expect(requests).toEqual(['第一条', '第一条'])
    expect(screen.getByRole('textbox')).toHaveValue('第二条草稿')
    expect(within(screen.getByRole('log')).getAllByText('第一条')).toHaveLength(1)
  })

  it('打开对话后原文区域不残留交接条，发送引用只保存在本轮', async () => {
    const user = userEvent.setup(), client = adapter()
    const references = [{ id: 'r', messages: [{ id: '9', conversationId: 'example', senderName: '示例成员', text: '引用正文' }] }] as unknown as ReferenceRange[]
    render(<Fixture client={client} initialReferences={references} />)
    await user.type(screen.getByRole('textbox'), '引用这个问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await screen.findByText('示例回答')
    expect(screen.getByRole('region', { name: '原文区域' })).toBeEmptyDOMElement()
    expect(screen.queryByText('不需要重复的会话名')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清除引用' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('log')).getByRole('button', { name: '1 条引用' })).toBeInTheDocument()
  })

  it('模型菜单按服务商搜索与选择，同名模型仍有明确归属', async () => {
    const user = userEvent.setup(), client = adapter()
    render(<Fixture client={client} />)
    await user.click(screen.getByRole('combobox', { name: '对话模型' }))
    const search = screen.getByRole('textbox', { name: '搜索模型' })
    await user.type(search, '示例服务 B')
    const list = screen.getByRole('listbox', { name: '模型' })
    expect(within(list).queryByText('示例服务 A')).not.toBeInTheDocument()
    await user.click(within(list).getByRole('option', { name: /同名模型/ }))
    expect(screen.getByRole('combobox', { name: '对话模型' })).toHaveAttribute('title', '同名模型 | 示例服务 B')
    expect(screen.getByRole('combobox', { name: '对话模型' })).toHaveFocus()
  })

  it('统计区分生成速度与端到端吞吐，按 Cherry 展示模型、缓存和耗时', async () => {
    const user = userEvent.setup(), client = adapter()
    client.respond = async () => ({ text: '统计示例', usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 100,
      firstTokenMs: 9000, durationMs: 10000, outputTokensPerSecond: 10 } })
    render(<Fixture client={client} />)
    await user.type(screen.getByRole('textbox'), '统计问题')
    await user.click(screen.getByRole('button', { name: '发送给 AI' }))
    await user.click(await screen.findByRole('button', { name: /输出 100/ }))
    const card = screen.getByRole('region', { name: '生成统计' })
    expect(card).toHaveTextContent('同名模型')
    expect(card).toHaveTextContent('示例服务 A')
    expect(card).toHaveTextContent('1,000 Tokens')
    expect(card).toHaveTextContent('100 Token/秒')
    expect(card).toHaveTextContent('10 Token/秒')
    expect(card).toHaveTextContent('未缓存')
    expect(card).toHaveTextContent('200 Tokens')
    expect(card).toHaveTextContent('缓存读取')
    expect(card).toHaveTextContent('800 Tokens')
    expect(card).not.toHaveTextContent('token 是')
  })
})
