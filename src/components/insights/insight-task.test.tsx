import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { InsightTaskDetails } from './insight-task'

it.each([
  {
    label: '读取只获得零值，写入均返回零值',
    usage: { totalInputTokens: 100, cacheReadTokens: 0, cacheReadTokensIncomplete: true, cacheWriteTokens: 0 },
    expected: { input: '100', read: '—', write: '0 词元' },
  },
  {
    label: '写入只有部分非零值，读取完整',
    usage: { inputTokens: 100, cacheReadTokens: 35, cacheWriteTokens: 8, cacheWriteTokensIncomplete: true },
    expected: { input: '至少 143', read: '35 词元', write: '—' },
  },
])('任务详情只显示完整缓存用量：$label', ({ usage, expected }) => {
  render(<InsightTaskDetails usage={usage} />)
  fireEvent.click(screen.getByRole('button', { name: '详情' }))

  expect(screen.getByText('输入词元').nextElementSibling?.textContent).toBe(expected.input)
  expect(screen.getByText('缓存读取').nextElementSibling?.textContent).toBe(expected.read)
  expect(screen.getByText('缓存写入').nextElementSibling?.textContent).toBe(expected.write)
})
