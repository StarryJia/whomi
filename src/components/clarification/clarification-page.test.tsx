import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ClarificationPage } from './clarification-page'
import { useClarification } from './use-clarification'
import type { ClarificationAdapter, ClarificationModel, ClarificationQuestion, ClarificationWithdrawal } from './types'

const prompt = '以上都不符合，我有自己的想法…'
const question: ClarificationQuestion = {
  id: 'friend', title: '朋友准备答辩时，你当时更想怎么帮他？',
  context: '他担心讲不清楚，你们聊了准备进度，也调整了练习时间。',
  options: [
    { id: 'listen', title: '更想先听他说完', description: '当时他需要有人听着' },
    { id: 'help', title: '主要想帮他赶完眼前的事', description: '我更担心他来不及' },
    { id: 'ask', title: '当时只是顺手问了问', description: '没有特别想表达什么' },
  ],
  source: { id: 'friend-source', conversationId: 'c1', messageId: 'm1', title: '朋友答辩', context: '准备与改约' },
}
const models: readonly ClarificationModel[] = [
  { id: 'demo', label: '示例模型', available: true },
  { id: 'unavailable', label: '不可用模型', available: false },
]

function makeAdapter(): ClarificationAdapter {
  return {
    submit: vi.fn(async () => ({ answerId: 'a1', persistence: 'preview' as const })),
    withdraw: vi.fn(async () => ({ persistence: 'preview' as const })),
  }
}

function Harness({ item = question, availableModels = models, adapter, availableSource = true, onSource = vi.fn() }: {
  item?: ClarificationQuestion | null
  availableModels?: readonly ClarificationModel[]
  adapter?: ClarificationAdapter
  availableSource?: boolean
  onSource?: () => void
}) {
  const controller = useClarification(adapter)
  return <ClarificationPage question={item ?? undefined} models={availableModels} controller={controller}
    headingRef={createRef()} onOpenSource={onSource} isSourceAvailable={() => availableSource} />
}

describe('问一问页面', () => {
  it('无问题时只显示轻松提示，不提供作答或独立返回操作', () => {
    render(<Harness item={null} />)
    expect(screen.getByRole('heading', { level: 1, name: '问一问' })).toBeInTheDocument()
    expect(screen.getByText('疑问今天请假了。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('三张牌直接可读，键盘聚焦不提交，空格可提交', async () => {
    const adapter = makeAdapter()
    render(<Harness adapter={adapter} />)
    const first = screen.getByRole('button', { name: question.options[0].title })
    first.focus()
    expect(adapter.submit).not.toHaveBeenCalled()
    expect(screen.getByText(question.options[0].description!)).toBeVisible()
    expect(screen.queryByRole('button', { name: '这些都不太贴近' })).not.toBeInTheDocument()
    await userEvent.setup().keyboard(' ')
    expect(adapter.submit).toHaveBeenCalledOnce()
    expect(await screen.findByText('已模拟提交，未保存。')).toBeInTheDocument()
  })

  it('选择模型不切换路径；输入聚焦停用卡牌，切回后保留草稿并归还焦点', async () => {
    const adapter = makeAdapter()
    render(<Harness adapter={adapter} />)
    const user = userEvent.setup()
    const first = screen.getByRole('button', { name: question.options[0].title })
    await user.selectOptions(screen.getByRole('combobox', { name: '选择模型' }), 'demo')
    expect(first).toBeEnabled()
    await user.type(screen.getByRole('textbox', { name: prompt }), '我当时更担心他熬夜。')
    expect(first).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '改用卡牌回答' }))
    expect(first).toBeEnabled()
    expect(first).toHaveFocus()
    expect(screen.getByRole('textbox', { name: prompt })).toHaveValue('我当时更担心他熬夜。')
    expect(adapter.submit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '发送回答' })).toBeDisabled()
  })

  it('中文组合输入及 Shift+Enter 不发送，普通 Enter 发送完整回答', async () => {
    const adapter = makeAdapter()
    render(<Harness adapter={adapter} />)
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: prompt })
    await user.type(input, '我想先听他说完。')
    await user.selectOptions(screen.getByRole('combobox', { name: '选择模型' }), 'demo')
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(adapter.submit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    expect(adapter.submit).toHaveBeenCalledWith(question.id, { kind: 'text', text: '我想先听他说完。', modelId: 'demo' })
    expect(await screen.findByText('已模拟提交，未保存。')).toBeInTheDocument()
  })

  it('模型菜单只展示可用模型，没有模型时仍允许草稿但不发送', async () => {
    const { rerender } = render(<Harness adapter={makeAdapter()} />)
    expect(screen.queryByRole('option', { name: '不可用模型' })).not.toBeInTheDocument()
    rerender(<Harness adapter={makeAdapter()} availableModels={[]} />)
    expect(screen.getByRole('combobox', { name: '选择模型' })).toBeDisabled()
    expect(screen.getByText('暂无可用模型。')).toBeInTheDocument()
    await userEvent.setup().type(screen.getByRole('textbox', { name: prompt }), '先记下来。')
    expect(screen.getByRole('button', { name: '发送回答' })).toBeDisabled()
  })

  it('来源失效时保留不可用入口，不能跳转', async () => {
    const onSource = vi.fn()
    render(<Harness availableSource={false} onSource={onSource} />)
    const source = screen.getByRole('button', { name: '回顾那段情景' })
    expect(source).toBeDisabled()
    expect(screen.getByText('原文暂不可用。')).toBeInTheDocument()
    await userEvent.setup().click(source)
    expect(onSource).not.toHaveBeenCalled()
  })

  it('未接入提交时可写草稿，卡牌及发送不可操作且不显示成功', async () => {
    render(<Harness />)
    expect(screen.getByRole('button', { name: question.options[0].title })).toBeDisabled()
    await userEvent.setup().type(screen.getByRole('textbox', { name: prompt }), '只是顺手问了问。')
    expect(screen.getByText('暂时无法提交，草稿仅保留在本次浏览中。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送回答' })).toBeDisabled()
    expect(screen.queryByText('回答已提交。')).not.toBeInTheDocument()
  })

  it('撤回等待真实回执，失败保留答案且可重试，成功回到原题', async () => {
    let resolveWithdrawal!: (result: ClarificationWithdrawal) => void
    const adapter = makeAdapter()
    adapter.withdraw = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<ClarificationWithdrawal>((resolve) => { resolveWithdrawal = resolve }))
    render(<Harness adapter={adapter} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: question.options[0].title }))
    await user.click(await screen.findByRole('button', { name: '撤回回答' }))
    expect(await screen.findByText('撤回失败，请重试。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试撤回' })).toHaveFocus()
    expect(screen.getByText(question.options[0].title)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试撤回' }))
    expect(screen.getByText('正在撤回…')).toBeInTheDocument()
    expect(screen.getByText('已模拟提交，未保存。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: prompt })).not.toBeInTheDocument()
    await act(async () => resolveWithdrawal({ persistence: 'preview' }))
    expect(screen.getByText('已模拟撤回，未保存。')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: prompt })).toBeEnabled()
    expect(screen.getByRole('button', { name: question.options[0].title })).toBeEnabled()
    expect(screen.getByRole('heading', { level: 2, name: question.title })).toBeInTheDocument()
  })

  it('真实回执使用提交文案，不承诺画像更新', async () => {
    const adapter: ClarificationAdapter = {
      submit: async () => ({ answerId: 'saved', persistence: 'saved' }),
      withdraw: async () => ({ persistence: 'saved' }),
    }
    render(<Harness adapter={adapter} />)
    await userEvent.setup().click(screen.getByRole('button', { name: question.options[1].title }))
    expect(await screen.findByText('回答已提交。')).toBeInTheDocument()
    expect(screen.queryByText(/画像.*更新/)).not.toBeInTheDocument()
  })

  it('卡牌提交失败后聚焦重试，键盘可继续完成回答', async () => {
    const adapter = makeAdapter()
    adapter.submit = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ answerId: 'retry', persistence: 'preview' })
    render(<Harness adapter={adapter} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: question.options[0].title }))
    expect(await screen.findByRole('button', { name: '重试提交' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('已模拟提交，未保存。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤回回答' })).toHaveFocus()
  })
})
