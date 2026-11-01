import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { MemoryArticle } from './memory-library'
import type { MemoryDimensions } from '../shared/memory'

const unknown: MemoryDimensions = { EI: null, SN: null, TF: null, JP: null }
it.each([
  [unknown, '暂难判断'],
  [{ ...unknown, JP: 'J' }, 'J · 偏好提前安排；其余维度暂难判断'],
  [{ EI: 'E', SN: 'N', TF: 'F', JP: 'P' }, 'ENFP'],
] as const)('同一篇文稿按有效维度呈现预测，保留其余两节', (dimensions, expected) => {
  render(<MemoryArticle report={{ format: 'memory-v2', dimensions, events: [{ title: '拿到钥匙', text: '你们约在东门碰面。' }], relationship: '你们似乎乐意互相搭把手。' }} />)
  expect(screen.getByText(expected)).toBeVisible()
  const article = within(screen.getByRole('article'))
  expect(article.getAllByRole('heading', { level: 3 }).map(node => node.textContent)).toEqual(['MBTI 预测', '我们的记忆', '我们的关系'])
  expect(article.getAllByText(/娱乐解读/)).toHaveLength(1)
})

it('历史报告保留原摘要、观察与解读范围', () => {
  render(<MemoryArticle report={{ summary: '原始摘要', observations: [{ text: '原始观察', evidenceMessageIds: ['1'], limitations: '只含本次讨论' }], limitations: '原始范围' }} />)
  for (const text of ['原始摘要', '原始观察', '只含本次讨论', '原始范围']) expect(screen.getByText(text)).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'MBTI 预测' })).toBeNull()
})
