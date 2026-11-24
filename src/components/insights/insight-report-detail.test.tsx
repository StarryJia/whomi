import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import App from '../../App'
import type { AnalysisTask } from '../../shared/ai-contract'
import type { InsightJudgment, InsightReport } from '../../shared/conversation-insights'
import type { DesktopApi } from '../../shared/desktop-api'

it('打开报告后才读取引文，失败时可继续阅读并重试', async () => {
  const user = userEvent.setup()
  const judgment: InsightJudgment = { dimension: 'EI', direction: 'E', text: '你提议一起出门。',
    supportingSources: [{ messageId: '20', revision: 'r20', excerpts: ['列表里的旧引文'] }], counterexampleSources: [], alternativeExplanations: [], limitations: [] }
  const report: InsightReport = { format: 'conversation-insights-v1', aboutYou: [{ content: [{ text: '你提了一个出游建议。' }] }],
    relationship: [{ content: [{ text: '我来安排', citationId: 'trip' }] }], judgments: [judgment],
    citations: [{ id: 'trip', conversationId: '1', fragments: [
      { sources: [{ messageId: '10', revision: 'r10' }] }, { sources: [{ messageId: '20', revision: 'r20' }, { messageId: '21', revision: 'r21' }] },
    ] }], limitations: [] }
  const task: AnalysisTask = { id: '24', conversationId: '1', conversationTitle: '小林', modelId: 'm', state: 'completed',
    analyzedMessages: 12, totalMessages: 12, skippedMessages: 0, usage: {}, valid: true, eventSequence: 3, report }
  let finish!: (value: InsightReport) => void
  const getReport = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const readInsightCitation = vi.fn().mockResolvedValue({ status: 'expired' })
  const api = { ai: { listAnalyses: async () => [task], getReport, readInsightCitation, onEvent: () => () => {} } } as unknown as DesktopApi
  const conversations = [{ id: '1', title: '小林', messages: [{ id: '20', sender: '我', text: '明天一起去？', isSelf: true }] }]
  render(<App preview conversations={conversations} importApi={api} />)
  await user.click(screen.getByRole('button', { name: '对话洞察' }))
  const entry = await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ })
  expect(getReport).not.toHaveBeenCalled()
  await user.click(entry)
  expect(screen.queryByText(/列表里的旧引文/)).toBeNull()
  await user.click(await screen.findByRole('button', { name: '重新读取引文' }))
  expect(getReport.mock.calls).toEqual([['24'], ['24']])
  expect(screen.getByText('你提了一个出游建议。')).toBeVisible()
  const quote = screen.getByRole('button', { name: '我来安排' })
  expect(quote).toHaveAttribute('aria-disabled', 'true')
  await user.click(quote)
  expect(readInsightCitation).not.toHaveBeenCalled()
  await act(async () => finish({ ...report, relationship: [{ content: [{ text: '我来安排', citationId: 'trip', quoteFragmentIndex: 1, quoteMessageId: '21' }] }],
    judgments: [{ ...judgment, supportingSources: [{ ...judgment.supportingSources[0], excerpts: ['明天一起去？'] }] }] }))
  expect(await screen.findByRole('button', { name: /明天一起去/ })).toBeVisible()
  await user.click(quote)
  expect(readInsightCitation).toHaveBeenCalledExactlyOnceWith({ taskId: '24', citationId: 'trip', fragmentIndex: 1, messageId: '21' })
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(quote).toHaveFocus()

  expect(screen.queryByRole('button', { name: '回到开头' })).toBeNull()
  expect(screen.queryByRole('button', { name: '打开完整会话' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '返回' }))
  expect(await screen.findByRole('button', { name: /小林.*会话洞察.*#24/ })).toHaveFocus()
})
