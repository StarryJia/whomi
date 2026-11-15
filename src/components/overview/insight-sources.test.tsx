import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RelationshipObservations } from './relationship-observations'

test('同一关系的多份有效报告均可回查，不把报告份数当关系数', () => {
  let selected = ''
  render(<RelationshipObservations observations={[{
    taskId: '23', title: '小林', dimensions: { EI: null, SN: null, TF: null, JP: 'J' },
    sourceReports: [{ id: '23', title: '九月合作' }, { id: '24', title: '十月合作' }],
  }]} onRead={id => { selected = id }} />)
  expect(screen.getByText('各维度暂难汇总，至少需要两段关系提供同一维度的观察。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '十月合作 #24' }))
  expect(selected).toBe('24')
})
