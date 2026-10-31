import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationWorkspace } from './workspace'
import type { ConversationAiAdapter } from './types'
import { AnswerContent } from './answer-content'

const answer = '你提供了具体支持。\n\n### 发生了什么\n朋友担心准备不完。\n\n### 可以观察到的行为\n- 确认需要\n- 约定时间\n- 保留选择\n\n| 原文线索 | 有限观察 |\n| --- | --- |\n| 明晚九点 | 具体支持 |\n| 先听建议还是倾诉 | 尊重需要 |'
function mount(respond: ConversationAiAdapter['respond'], overrides: Partial<ConversationAiAdapter> = {}) {
  const client: ConversationAiAdapter = { models: [{ id: 'a', label: '模型甲', model: 'model-a' }], skills: [], respond, analyze: async () => {}, ...overrides }
  return render(<ConversationWorkspace conversationId="example" title="示例" references={[]}
    onClearReferences={() => {}} onJumpReference={() => {}} adapter={client}>
    {({ chatControl }) => <section aria-label="原文">{chatControl}<p>### 原文符号必须保留</p></section>}
  </ConversationWorkspace>)
}
async function send() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '这段示例里，我怎样回应了朋友？')
  await user.click(screen.getByRole('button', { name: '发送给 AI' }))
  return user
}
describe('回答阅读排版', () => {
  it('最终快照替换同长度流式片段时显示最终文字', async () => {
    const view = render(<AnswerContent id="same" text="流式内容" status="running" />)
    expect(screen.getByText('流式内容')).toBeVisible()
    view.rerender(<AnswerContent id="same" text="完整回答" status="done" />)
    expect(await screen.findByText('完整回答')).toBeVisible()
  })
  it('回答形成可阅读标题、列表与表格，原始聊天保持纯文本', async () => {
    mount(async () => ({ text: answer }))
    await send()
    const log = screen.getByRole('log')
    expect(await within(log).findByRole('heading', { name: '发生了什么' })).toBeVisible()
    expect(within(log).getAllByRole('heading')).toHaveLength(2)
    expect(within(log).getAllByRole('listitem')).toHaveLength(3)
    expect(within(within(log).getByRole('table')).getAllByRole('row')).toHaveLength(3)
    expect(screen.getByRole('region', { name: '原文' })).toHaveTextContent('### 原文符号必须保留')
  })
  it('未闭合流式片段逐步补全，停止后保留已收到正文', async () => {
    let write!: (text: string) => void
    mount((_request, options) => { write = options.onText; return new Promise(() => {}) })
    const user = await send()
    await act(async () => write('### 可以观察'))
    expect(screen.getByRole('log')).toHaveTextContent('可以观察')
    await act(async () => write(answer))
    expect(within(screen.getByRole('log')).getByRole('table')).toBeVisible()
    const table = within(screen.getByRole('log')).getByRole('table')
    const heading = within(screen.getByRole('log')).getByRole('heading', { name: '发生了什么' })
    await user.click(screen.getByRole('button', { name: '停止回答' }))
    expect(within(screen.getByRole('log')).getByRole('table')).toHaveTextContent('尊重需要')
    expect(within(screen.getByRole('log')).getByRole('table')).toBe(table)
    expect(within(screen.getByRole('log')).getByRole('heading', { name: '发生了什么' })).toBe(heading)
  })
  it('模型文本中的脚本和危险链接不会成为可执行内容', async () => {
    mount(async () => ({ text: '[危险](javascript:alert(1))\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[正常](https://example.com)' }))
    await send()
    const log = screen.getByRole('log')
    expect(await within(log).findByRole('link', { name: '正常' })).toHaveAttribute('href', 'https://example.com/')
    expect(log.querySelector('script,[onerror],a[href^="javascript:"]')).toBeNull()
  })
  it('旧回答和统计使用生成时模型，缺失身份不冒充当前模型', async () => {
    mount(async () => ({ text: answer }), { restoreThread: async () => [
      { id: '1', requestId: 'old', prompt: '旧问题', referenceIds: [], modelId: 'a', modelIdentity: { id: 'a', version: 1, label: '生成时名称', model: 'old-a' }, text: '旧回答', state: 'completed', usage: { outputTokens: 100 } },
      { id: '2', requestId: 'unknown', prompt: '更早的问题', referenceIds: [], modelId: 'deleted-model', text: '缺失身份的回答', state: 'completed' },
    ] })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'AI 对话' }))
    await screen.findByText('旧回答')
    expect(screen.getByRole('log')).toHaveTextContent('生成时名称')
    expect(screen.getByRole('log')).toHaveTextContent('未知模型')
    expect(screen.getByRole('log')).not.toHaveTextContent('模型甲')
    await user.click(screen.getByRole('button', { name: /输出 100/ }))
    expect(screen.getByRole('region', { name: '生成统计' })).toHaveTextContent('生成时名称')
    expect(screen.getByRole('region', { name: '生成统计' })).toHaveTextContent('old-a')
  })
  it('摘要和详情共用模型生成速度，缺少首次输出时间不伪造速度', async () => {
    mount(async () => ({ text: answer, usage: { outputTokens: 100, firstTokenMs: 9000, durationMs: 10000, outputTokensPerSecond: 10 } }))
    const user = await send()
    const summary = screen.getByRole('button', { name: /输出 100/ })
    expect(summary).toHaveTextContent('100 token/秒')
    await user.click(summary)
    const stats = screen.getByRole('region', { name: '生成统计' })
    expect(stats).toHaveTextContent('100 Token/秒')
    expect(stats).toHaveTextContent('10 Token/秒')
  })
  it('未知模型速度只显示已知输出', async () => {
    mount(async () => ({ text: answer, usage: { outputTokens: 100, durationMs: 10000, outputTokensPerSecond: 10 } }))
    await send()
    expect(screen.getByRole('button', { name: /输出 100/ })).not.toHaveTextContent('token/秒')
  })
  it('复制完整回答源文本，写入失败可重试且保留后续草稿', async () => {
    mount(async () => ({ text: answer }))
    const user = await send()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    await user.type(screen.getByRole('textbox'), '下一条草稿')
    await user.click(screen.getByRole('button', { name: '复制回答' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败')
    expect(screen.queryByRole('button', { name: '已复制' })).not.toBeInTheDocument()
    act(() => screen.getByRole('button', { name: '复制回答' }).focus())
    await user.keyboard('{Enter}')
    expect(write).toHaveBeenLastCalledWith(answer)
    expect(await screen.findByRole('status')).toHaveTextContent('已复制')
    expect(screen.getByRole('textbox')).toHaveValue('下一条草稿')
  })
  it('部分失败保留已收到的文字并允许复制', async () => {
    mount(async (_request, options) => { options.onText('已生成的部分回答'); throw new Error('连接中断，请重试。') })
    const user = await send()
    expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: '复制回答' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已复制')
    expect(write).toHaveBeenCalledWith('已生成的部分回答')
    expect(screen.getByRole('log')).toHaveTextContent('已生成的部分回答')
  })
})
