import { expect, test } from 'vitest'
import { compactScoredEvents, finishScoredMemory } from '../../electron/data/ai/memory-scoring'
import { aggregateRelationships, currentMemoryContributions, scoreDimensions } from '../../src/shared/memory'
import type { AnalysisTask } from '../../src/shared/ai-contract'
import type { MemoryEvent } from '../../electron/data/ai/memory-notes'

const note = (key: string, direction: string, id: string): MemoryEvent => ({ key, text: key, evidenceMessageIds: [id], signals: [{ direction, messageId: id }] })
const draft = { groups: [['搬家','约货车'],['看展'],['试讲']], events: [{ key: '搬家', title: '那次搬家', text: '一起将书箱搬进新家。' }], relationship: '你们会一起准备。' }
const material = [note('搬家','J','1'), note('约货车','J','2'), note('看展','J','3'), note('试讲','P','4')]
const order = new Map(material.map((event, i) => [event.evidenceMessageIds[0], i]))

test('每件事每维一票，合并未选入正文的别名，三件中的两件同向才生成方向', () => {
  const report = finishScoredMemory(draft, material, order)
  expect(report).toMatchObject({ format: 'memory-v3', eventVotes: { JP: [2,1] }, dimensions: { JP: 'J', EI: null } })
  const hidden = { ...draft, events: [{ key: '看展', title: '看展', text: '约好展览。' }] }
  expect(finishScoredMemory(hidden, material, order).eventVotes.JP).toEqual([2,1])
  const ambiguous = material.map(event => event.key === '搬家' ? { ...event, signals: [...event.signals, { direction: 'P', messageId: '1' }] } : event)
  expect(finishScoredMemory(draft, ambiguous, order).dimensions.JP).toBe(null)
  expect(() => finishScoredMemory({ ...draft, groups: [['搬家','约货车'],['看展']] }, material, order)).toThrow()
})

test('单一关系、旧成稿及未知不产生全局倾向；两段关系平票与事件数量无关', () => {
  const report = finishScoredMemory(draft, material, order)
  const task = (id: string, conversationId: string, content: AnalysisTask['report']): AnalysisTask => ({ id, conversationId, modelId: 'm', state: 'completed', analyzedMessages: 3, totalMessages: 3, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1, report: content })
  const old = { format: 'memory-v2' as const, dimensions: report.dimensions, events: report.events, relationship: report.relationship }
  const a = task('1', '1', report), b = task('2', '2', { ...report, eventVotes: { ...report.eventVotes, JP: [0,18] }, dimensions: { ...report.dimensions, JP: 'P' } })
  expect(aggregateRelationships(currentMemoryContributions([a, task('3','3',old)])).JP).toBe(null)
  expect(aggregateRelationships(currentMemoryContributions([b,a])).JP).toBe('tie')
  expect(aggregateRelationships(currentMemoryContributions([b,a, task('4','4',report)])).JP).toBe('J')
})

test('压缩只合并事件，保留未入选正文的原始信号，重复借用同一依据不能凑足三件事', () => {
  const compact = { groups: draft.groups, events: draft.groups.map(([key]) => ({ key, text: '压缩后的事件经过。' })) }
  const reduced = compactScoredEvents(compact, material)
  expect(reduced[0].signals).toEqual([{ direction: 'J', messageId: '1' }, { direction: 'J', messageId: '2' }])
  const final = { ...draft, groups: reduced.map(event => [event.key]) }
  expect(finishScoredMemory(final, reduced, order).eventVotes.JP).toEqual([2,1])
  const repeated = [note('月初','J','1'),note('月中','J','1'),note('月底','J','3')]
  expect(finishScoredMemory({ groups: repeated.map(event => [event.key]), events: [{key:'月初',title:'月初',text:'聊起之前的计划。'}], relationship:'一起商量。' }, repeated, order).eventVotes.JP).toEqual([1,0])
  expect(scoreDimensions({ EI: [3,2], SN: [1,2], TF: [2,0], JP: [4,2] })).toEqual({ EI:null, SN:'N', TF:null, JP:'J' })
})
