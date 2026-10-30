import { createRef } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PersonalOverview } from './personal-overview'
import { useOverviewFeedback } from './use-overview-feedback'
import type { FeedbackSaver, OverviewData, SourceReference } from './types'

const data: OverviewData = {
  materialStatus: 'partial',
  preferences: {
    energy: { status: 'known', leaning: 'left', strength: 'slight' },
    decisions: { status: 'known', leaning: 'right', strength: 'slight' },
  },
  discoveries: [{
    id: 'care', title: '你可能会用记得，来表达关心。',
    selfDescription: '回顾与朋友相处时，你觉得自己不太会表达关心。',
    observation: '在这些熟悉朋友的交流中，你可能更常通过后续跟进表达关心。',
    scenes: [{
      title: '朋友准备答辩的那几天',
      context: '朋友准备答辩，担心临场忘词。',
      interaction: '你们聊过准备情况，朋友说自己还有些紧张。',
      behavior: '答辩结束后，你主动问起结果，又询问对方有没有休息。',
      sourceIds: ['friend'],
    }],
    qualification: '这些线索来自熟悉朋友之间的交流，还不足以概括其他关系。',
    sources: [{ id: 'friend', conversationId: 'c1', messageId: 'm1', title: '朋友近况', context: '答辩前的担忧与结束后的跟进。' }],
  }],
}

function Harness({ overview = data, saveFeedback, onImport = () => {}, onOpenSource = () => {}, available = true }: {
  overview?: OverviewData | null; saveFeedback?: FeedbackSaver; onImport?: () => void
  onOpenSource?: (source: SourceReference) => void; available?: boolean
}) {
  const feedback = useOverviewFeedback(saveFeedback)
  return <PersonalOverview data={overview ?? undefined} headingRef={createRef()} onReturnToCover={() => {}} onImport={onImport}
    onOpenSource={onOpenSource} isSourceAvailable={() => available} feedback={feedback} />
}

describe('个人总览', () => {
  it('没有总览数据时保留诚实空状态，并提供明确的返回 Hello 操作', () => {
    render(<Harness overview={null} />)
    expect(screen.getByText('还没有可查看的总览。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回 Hello' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择记录' })).toBeInTheDocument()
    expect(screen.queryByLabelText('当前推测类型')).not.toBeInTheDocument()
  })

  it('说说看法将焦点移到已有输入框，并保留已写的草稿', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const comment = screen.getByRole('textbox', { name: '我的补充' })
    await user.type(comment, '先写下的情境。')
    await user.click(screen.getByRole('button', { name: '说说看法' }))
    expect(comment).toHaveFocus()
    expect(comment).toHaveValue('先写下的情境。')
  })

  it('未知偏好显示问号且没有倾向轨道，四组偏好都有完整说明', () => {
    render(<Harness />)
    expect(screen.getByLabelText('当前推测类型')).toHaveTextContent('E?F?')
    const unknown = screen.getByRole('group', { name: '实感 S / 直觉 N' })
    expect(within(unknown).getByText('?')).toBeInTheDocument()
    expect(within(unknown).queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('互动或独处中恢复精力。')).toBeInTheDocument()
    expect(screen.getByText('具体经验与关联可能。')).toBeInTheDocument()
    expect(screen.getByText('逻辑与感受在决策中的侧重。')).toBeInTheDocument()
    expect(screen.getByText('提前安排与保留弹性。')).toBeInTheDocument()
  })

  it('均衡偏好保留中点，汇总对应位仍为问号并解释含义', () => {
    render(<Harness overview={{ ...data, preferences: { ...data.preferences, energy: { status: 'known', leaning: 'balanced' } } }} />)
    expect(screen.getByLabelText('当前推测类型')).toHaveTextContent('??F?')
    const balanced = screen.getByRole('group', { name: '外向 E / 内向 I' })
    expect(within(balanced).getByRole('img', { name: '外向与内向较均衡，标记位于中点' })).toBeInTheDocument()
    expect(screen.getByText(/外向与内向这一位较均衡/)).toBeInTheDocument()
  })

  it('先呈现背景、交流和行为，再呈现观察，原文入口包含情境摘要并可打开', async () => {
    const opened: SourceReference[] = []
    render(<Harness onOpenSource={(source) => opened.push(source)} />)
    const user = userEvent.setup()
    const scene = screen.getByRole('group', { name: '朋友准备答辩的那几天' })
    expect(scene).toHaveTextContent('朋友准备答辩，担心临场忘词。')
    expect(scene).toHaveTextContent('你们聊过准备情况，朋友说自己还有些紧张。')
    expect(scene).toHaveTextContent('答辩结束后，你主动问起结果，又询问对方有没有休息。')
    const observation = screen.getByText(data.discoveries[0].observation)
    expect(scene.compareDocumentPosition(observation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /朋友近况.*答辩前的担忧与结束后的跟进/ }))
    expect(opened[0]?.messageId).toBe('m1')
  })

  it('来源不可回查时保留键盘入口并说明不可用，点击不会打开', async () => {
    const opened: SourceReference[] = []
    render(<Harness available={false} onOpenSource={(source) => opened.push(source)} />)
    const source = screen.getByRole('button', { name: /朋友近况.*原文暂不可用/ })
    expect(source).toHaveAttribute('aria-disabled', 'true')
    expect(source).not.toBeDisabled()
    await userEvent.setup().click(source)
    expect(opened).toHaveLength(0)
    expect(screen.getByText('原文暂不可用，这条观察仍待核对。')).toBeInTheDocument()
  })

  it('可以不投票直接评论，未接入保存时保留输入并说明未保存', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: '我的补充' }), '只在熟悉的朋友面前这样。')
    expect(screen.getByRole('button', { name: '赞同' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('textbox', { name: '我的补充' })).toHaveValue('只在熟悉的朋友面前这样。')
    expect(screen.getByText('暂时无法保存，草稿仅保留在本次浏览中。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交反馈' })).toBeDisabled()
    expect(screen.queryByText('已保存')).not.toBeInTheDocument()
  })

  it('模拟回执明确未保存，后续分析状态与保存反馈分开', async () => {
    render(<Harness saveFeedback={async () => ({ persistence: 'preview', analysis: 'pending' })} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '赞同' }))
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(await screen.findByText('模拟完成 · 未保存')).toBeInTheDocument()
    expect(screen.getByText('待后续分析')).toBeInTheDocument()
    expect(screen.queryByText('已保存')).not.toBeInTheDocument()
  })

  it('没有材料时选择记录只触发选择入口，未分析记录不声称已开始分析', async () => {
    let importCount = 0
    const { rerender } = render(<Harness overview={{ materialStatus: 'none', discoveries: [] }} onImport={() => { importCount++ }} />)
    expect(screen.queryByLabelText('当前推测类型')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: '选择记录' }))
    expect(importCount).toBe(1)
    rerender(<Harness overview={{ materialStatus: 'unanalysed', discoveries: [] }} />)
    expect(screen.getByText('已有记录，尚未形成分析结果。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开始分析' })).not.toBeInTheDocument()
  })
})
