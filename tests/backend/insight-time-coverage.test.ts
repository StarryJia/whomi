import { expect, test } from 'vitest'
import type { InsightReport, InsightSnapshot } from '../../src/shared/conversation-insights'
import { defaultProcessing } from '../../src/shared/settings-contract'
import type { InsightEvidenceCard } from '../../electron/data/ai/insight-evidence-card'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'
import type { InsightSegmentPlan } from '../../electron/main/insight-segmentation'
import { analyzeInsightTimeCoverage } from '../../electron/main/insight-time-coverage'
import { generatePiInsight } from '../../electron/main/pi-insight-generation'
import { sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'

const source = (index: number) => ({ messageId: String(2000 + index), revision: 'r' })
const snapshot = (length: number): InsightSnapshot => ({ taskId: '5', scope: { kind: 'all' }, timezone: 'UTC',
  sourceStartTimeMs: null, sourceEndTimeMs: null, createdAtMs: 0, sources: Array.from({ length }, (_, i) => source(i)) })
const report = (...indices: number[]): InsightReport => ({
  format: 'conversation-insights-v1', aboutYou: [], relationship: [],
  citations: [{ id: 'a', conversationId: '9', fragments: [{ sources: indices.map(source) }] }],
})
const segments = (count: number): InsightSegmentPlan[] => Array.from({ length: count }, (_, i) => ({
  index: i, startIndex: i * 10, endIndex: i * 10 + 9, startMessageId: source(i * 10).messageId,
  endMessageId: source(i * 10 + 9).messageId, startTimeMs: null, endTimeMs: null, messageCount: 10, estimatedTokens: 50,
}))
const empty: InsightEvidenceCard = { period: '示例时段', events: [], selfSignals: [], riskSignals: [], revisions: [], openThreads: [] }
const evidence = { ...empty, events: [{ summary: '确认聚会时间', options: '', selfChoice: '同意', counterpartResponse: '好', messageIds: ['2000'] }] }

test('正文引用、人格依据与反例按唯一编号计入五等分；每段按消息顺序计数', () => {
  const draft = report(0, 1, 1, 8, 9)
  draft.judgments = [{ dimension: 'EI', direction: null, text: '待核实', supportingSources: [source(1), source(2)],
    counterexampleSources: [source(7)], alternativeExplanations: [], limitations: [] }]
  expect(analyzeInsightTimeCoverage(snapshot(10), draft, segments(1))).toMatchObject({
    buckets: [2, 1, 0, 1, 2], segmentCitationCounts: [6], totalCitations: 6, needsCorrection: false,
  })
})

test('双段有前期事件但无前段引用时给出具体段号、消息范围及事实；判断中的早期反例也算覆盖', () => {
  const snap = snapshot(20), plans = segments(2)
  const draft = report(19)
  const analysis = analyzeInsightTimeCoverage(snap, draft, plans, [evidence, empty])
  expect(analysis).toMatchObject({ totalCitations: 1, segmentCitationCounts: [0, 1], uncoveredEarlierSegments: [0], needsCorrection: true })
  for (const term of ['第 1 段', '2000', '2009', '确认聚会时间', 'read_messages']) expect(analysis.correctionPrompt).toContain(term)
  draft.judgments = [{ dimension: 'EI', direction: null, text: '待核实', supportingSources: [],
    counterexampleSources: [source(3)], alternativeExplanations: [], limitations: [] }]
  expect(analyzeInsightTimeCoverage(snap, draft, plans, [evidence, empty]).needsCorrection).toBe(false)
})

test('多段仅以前半段为修正门槛，风险事实也属于证据；仅有待核实问题时不要求补引', () => {
  const risk = { ...empty, riskSignals: [{ fact: '记录中的威胁', messageIds: ['2012'] }] }
  const thread = { ...empty, openThreads: [{ text: '尚待核实', messageIds: ['2001'] }] }
  const run = (draft: InsightReport, cards: InsightEvidenceCard[]) => analyzeInsightTimeCoverage(snapshot(40), draft, segments(4), cards)
  expect(run(report(20, 39), [thread, risk, evidence, empty])).toMatchObject({ uncoveredEarlierSegments: [1], needsCorrection: true })
  expect(run(report(12, 39), [evidence, risk, evidence, empty])).toMatchObject({ uncoveredEarlierSegments: [0, 2], needsCorrection: false })
  expect(run(report(39), [thread, empty, evidence, empty]).needsCorrection).toBe(false)
  expect(run(report(), [evidence, risk, evidence, empty]).needsCorrection).toBe(false)
  expect(analyzeInsightTimeCoverage(snapshot(30), report(15, 20), segments(3), [evidence, evidence, evidence]).needsCorrection).toBe(true)
})

test('单段至少五十条且全部引用都在后 40% 才要求回查', () => {
  expect(analyzeInsightTimeCoverage(snapshot(49), report(48)).needsCorrection).toBe(false)
  expect(analyzeInsightTimeCoverage(snapshot(50), report(30, 49))).toMatchObject({ needsCorrection: true, buckets: [0, 0, 0, 1, 1] })
  expect(analyzeInsightTimeCoverage(snapshot(50), report(29, 49)).needsCorrection).toBe(false)
  expect(analyzeInsightTimeCoverage(snapshot(50), report()).needsCorrection).toBe(false)
})

test('单段成稿只回查早期一次，合法的晚期集中报告可以保存', async () => {
  const snap = snapshot(50), last = snap.sources.at(-1)!.messageId
  const text = JSON.stringify({ aboutYou: [{ content: [{ text: '确认', citationId: 'c' }] }],
    relationship: [{ content: [{ text: '商定时间。' }] }], citations: [{ id: 'c', fragments: [{ messageIds: [last] }] }], judgments: sampleJudgments() })
  const prompts: string[] = []
  const result = await generatePiInsight({ snapshot: snap, conversationId: '9', thinkingLevel: undefined, prompts: defaultInsightPrompts,
    model: { id: 'm', model: 'local', label: '模拟', baseUrl: 'http://localhost', enabled: true, hasCredential: false,
      version: 1, contextWindow: 16000, maxTokens: 800 },
    processing: defaultProcessing, signal: new AbortController().signal, operation: aiOperation(undefined, 'insight', 'generate'),
    checkpoint: { version: 'pi-insight-v1', taskId: snap.taskId, checkpoint: 'read', processing: defaultProcessing,
      coverage: { coveredMessageIds: snap.sources.map(s => s.messageId), partial: {} }, requests: 1, stalled: 0, input: 0, output: 0 },
    read: async () => [], save: async () => {}, run: async input => {
      prompts.push(input.prompt)
      expect(prompts.length).toBeLessThanOrEqual(2)
      return { text, checkpoint: 'done', usage: {} }
    } })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('前 60%')
  expect(analyzeInsightTimeCoverage(snap, result).needsCorrection).toBe(true)
})
