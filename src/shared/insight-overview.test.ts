import { expect, test } from 'vitest'
import type { AnalysisTask } from './ai-contract'
import type { InsightJudgment } from './conversation-insights'
import { currentOverviewContributions } from './insight-overview'

// 以下报告与来源均为虚构样本。
const ref = (id: string) => ({ messageId: id, revision: `revision-${id}` })
const judgment = (direction: 'J' | 'P' | null, ids = ['1']): InsightJudgment => ({
  dimension: 'JP', direction, text: '这段合作中的安排方式', supportingSources: ids.map(ref),
  counterexampleSources: [], alternativeExplanations: [], limitations: ['仅限本次合作'],
})
const task = (id: string, judgments: InsightJudgment[], overrides: Partial<AnalysisTask> = {}): AnalysisTask => ({
  id, conversationId: '1', modelId: 'm', state: 'completed', valid: true, eventSequence: 3,
  analyzedMessages: 3, totalMessages: 3, skippedMessages: 0, usage: {},
  report: { format: 'conversation-insights-v1', aboutYou: [], relationship: [], citations: [], limitations: [], judgments },
  ...overrides,
})

test('重叠报告只保留一组原文依据，并可追到所有仍有效报告', () => {
  const [relation] = currentOverviewContributions([task('23', [judgment('J')]), task('24', [judgment('J')])])
  expect(relation.dimensions.JP).toBe('J')
  expect(relation.sourceTaskIds).toEqual(['23', '24'])
  expect(relation.evidence.JP).toEqual([{ ...ref('1'), conversationId: '1' }])
})

test('冲突不按报告数量投票，删除后仅使用剩余有效判断', () => {
  const september = task('23', [judgment('J')])
  const october = task('24', [judgment('P', ['2'])])
  const repeated = task('25', [judgment('J')])
  expect(currentOverviewContributions([september, october, repeated])[0].dimensions.JP).toBeNull()
  const [remaining] = currentOverviewContributions([september])
  expect(remaining.dimensions.JP).toBe('J')
  expect(remaining.sourceTaskIds).toEqual(['23'])
  expect(remaining.evidence.JP.map(source => source.messageId)).toEqual(['1'])
  expect(currentOverviewContributions([])).toEqual([])
})

test('失败、无效、未保存报告不贡献，重复完成按报告编号去重', () => {
  const saved = task('23', [judgment('J')])
  const [relation] = currentOverviewContributions([
    saved, saved, task('24', [judgment('P')], { state: 'failed' }),
    task('25', [judgment('P')], { valid: false }), task('26', [], { report: undefined }),
  ])
  expect(relation.sourceTaskIds).toEqual(['23'])
  expect(relation.dimensions.JP).toBe('J')
})

test('不同会话分别保留来源，移除冲突报告后恢复其余判断', () => {
  const first = task('10', [judgment('J')])
  const entries = currentOverviewContributions([first, task('24', [judgment('P', ['2'])]), task('30', [judgment('J')], { conversationId: '2' })])
  expect(entries.map(item => [item.conversationId, item.dimensions.JP])).toEqual([['1', null], ['2', 'J']])
  expect(currentOverviewContributions([first])[0]).toMatchObject({ dimensions: { JP: 'J' }, sourceTaskIds: ['10'] })
})

test('改名不改变判断，明确的不确定判断不会被同来源多数报告淹没', () => {
  const original = task('23', [judgment('J')])
  const renamed = { ...original, title: '那次合作', eventSequence: 4 }
  expect(currentOverviewContributions([renamed])[0].dimensions).toEqual(currentOverviewContributions([original])[0].dimensions)
  expect(currentOverviewContributions([renamed, task('24', [judgment(null)])])[0].dimensions.JP).toBeNull()
})

test('只含反例的不确定判断纳入总览，删除来源报告后恢复原有倾向', () => {
  const initial = task('23', [judgment('J')])
  const exception = task('24', [{ ...judgment(null, []), counterexampleSources: [ref('2')] }])
  const unsupported = task('25', [judgment(null, [])])
  const [combined] = currentOverviewContributions([initial, exception, unsupported])
  expect(combined.dimensions.JP).toBeNull()
  expect(combined.sourceTaskIds).toEqual(['23', '24'])
  expect(combined.evidence.JP.map(source => source.messageId)).toEqual(['1', '2'])
  expect(currentOverviewContributions([initial, unsupported])[0]).toMatchObject({ dimensions: { JP: 'J' }, sourceTaskIds: ['23'] })
})
