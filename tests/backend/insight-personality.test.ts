import { expect, test } from 'vitest'
import { parseReport } from '../../electron/main/insight-generation'
import { validateAiResult } from '../../src/shared/ai-validation'
import { dimensionKeys } from '../../src/shared/conversation-insights'

const revisions = new Map(['1', '2'].map(messageId => [messageId, { messageId, revision: 'a'.repeat(64) }]))
const section = [{ content: [{ text: '先约时间', citationId: 'c' }] }]
const draft = { aboutYou: section, relationship: section, citations: [{ id: 'c', fragments: [{ messageIds: ['1'] }] }] }
const observations = dimensionKeys.map(dimension => ({
  dimension, direction: dimension === 'JP' ? 'J' : null, text: dimension === 'JP' ? '你提议提前安排时间。' : '这段聊天只讨论了日程。',
  supportingIds: dimension === 'JP' ? ['1'] : [], counterexampleIds: [], alternativeExplanations: [], limitations: [],
}))
function parse(judgments?: unknown, fields = {}) {
  const response = { text: JSON.stringify({ ...draft, judgments, ...fields }), usage: {}, checkpoint: 'done' }
  return parseReport(response, '8', revisions, new Set(revisions.keys()), new Set(['1']), null)
}

test('有具体风险的报告保留首段事实及其原文引用，普通报告省略标记', () => {
  const risk = [{ content: [{ text: '你说「' }, { text: '我有伤害自己的念头', citationId: 'c' }, { text: '」，明确表达了当时的自伤想法。' }] }]
  const marked = parse(dimensionKeys.map(dimension => ({ dimension, direction: null, text: '这次交谈无法判断这项倾向。' })), {
    safetyLead: true, aboutYou: risk, relationship: [{ content: [{ text: 'ta 问你是否有人陪伴。' }] }],
  })
  expect(marked.safetyLead).toBe(true)
  expect(marked.aboutYou).toEqual(risk)
  expect(marked.citations[0].fragments[0].sources).toEqual([revisions.get('1')])
  expect(() => validateAiResult('getReport', marked)).not.toThrow()
  expect(parse(observations)).not.toHaveProperty('safetyLead')
  expect(parse(observations, { safetyLead: false })).not.toHaveProperty('safetyLead')
  expect(() => parse(observations, { safetyLead: 'true' })).toThrow()
  expect(() => validateAiResult('getReport', { ...marked, aboutYou: [] })).toThrow()
  expect(() => validateAiResult('getReport', { ...marked, aboutYou: [{ content: [] }] })).toThrow()
})

test('新报告可以省略全局限制，旧报告的限制仍按字符串列表校验', () => {
  const { limitations, ...withoutLimitations } = parse(observations)
  expect(limitations).toEqual([])
  expect(() => validateAiResult('getReport', withoutLimitations)).not.toThrow()
  const legacy = parse(observations, { limitations: ['记录只涵盖这次改期。'] })
  expect(legacy.limitations).toEqual(['记录只涵盖这次改期。'])
  expect(() => validateAiResult('getReport', legacy)).not.toThrow()
  expect(() => parse(observations, { limitations: null })).toThrow()
  expect(() => validateAiResult('getReport', { ...legacy, limitations: null })).toThrow()
})

test('Pi 新报告须评估四维，未知可没有支持原文，已判断的维度必须有本人依据', () => {
  const report = parse(observations)
  expect(report.judgments?.map(item => item.direction)).toEqual([null, null, null, 'J'])
  expect(() => validateAiResult('getReport', report)).not.toThrow()
  expect(() => parse()).toThrow('请补齐')
  expect(() => parse([...observations.slice(0, 3), observations[0]])).toThrow('请补齐')
  expect(() => parse(observations.slice(1))).toThrow('请补齐')
  expect(() => parse([{ ...observations[0], text: '  ' }, ...observations.slice(1)])).toThrow()
  for (const supportingIds of [[], ['2'], ['3']]) {
    expect(() => parse([...observations.slice(0, 3), { ...observations[3], supportingIds }])).toThrow()
  }
  expect(() => validateAiResult('getReport', { ...report, judgments: undefined })).not.toThrow()
  expect(() => validateAiResult('getReport', { ...report, judgments: [] })).not.toThrow()
})

test('Pi 新报告省略空的附加列表仍能保存，明确方向继续要求本人依据', () => {
  const compact = observations.map(({ dimension, direction, text }) => ({ dimension, direction, text }))
  expect(() => parse(compact)).toThrow()
  const report = parse([...compact.slice(0, 3), { ...compact[3], supportingIds: ['1'] }])
  expect(report.judgments).toEqual(parse(observations).judgments)
  expect(() => validateAiResult('getReport', report)).not.toThrow()
})

test('同一来源可在分析中引用多个片段，每个短句只登记一次', () => {
  const first = { messageId: '1', text: '一起约' }
  const quoted = (excerpts: typeof first[]) => parse([...observations.slice(0, 3), { ...observations[3], excerpts }])
  expect(() => quoted([first, first])).toThrow()
  expect(() => quoted([{ ...first, messageId: '2' }])).toThrow()
  expect(quoted([first, { ...first, text: '周三' }]).judgments?.at(-1)?.supportingSources[0]).toMatchObject({ excerpts: ['一起约', '周三'] })
})
