import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { InsightTaskDetails } from './insight-task'

it.each([
  {
    label: '读取只获得零值，写入均返回零值',
    usage: { totalInputTokens: 100, cacheReadTokens: 0, cacheReadTokensIncomplete: true, cacheWriteTokens: 0 },
    expected: { input: '100', read: '0 token', write: '0 token' },
  },
  {
    label: '写入只有部分非零值，读取完整',
    usage: { inputTokens: 100, cacheReadTokens: 35, cacheWriteTokens: 8, cacheWriteTokensIncomplete: true },
    expected: { input: '143', read: '35 token', write: '8 token' },
  },
])('任务详情显示截至当前回执的累计用量：$label', ({ usage, expected }) => {
  render(<InsightTaskDetails usage={usage} />)
  fireEvent.click(screen.getByRole('button', { name: '详情' }))

  expect(screen.getByText('输入 token').nextElementSibling?.textContent).toBe(expected.input)
  expect(screen.getByText('缓存读取').nextElementSibling?.textContent).toBe(expected.read)
  expect(screen.getByText('缓存写入').nextElementSibling?.textContent).toBe(expected.write)
})

it('等待回执时保留已知输入，回执到达后更新累计值', () => {
  const view = render(<InsightTaskDetails usage={{ incomplete: true }} />)
  fireEvent.click(screen.getByRole('button', { name: '详情' }))
  const input = screen.getByText('输入 token').nextElementSibling
  expect(input?.textContent).toBe('—')

  view.rerender(<InsightTaskDetails usage={{ totalInputTokens: 149736, incomplete: true }} />)
  expect(input?.textContent).toBe('149,736')
  view.rerender(<InsightTaskDetails usage={{ totalInputTokens: 150000 }} />)
  expect(input?.textContent).toBe('150,000')
})
