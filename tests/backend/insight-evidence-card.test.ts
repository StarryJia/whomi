import { expect, test } from 'vitest'
import type { InsightEvidenceCard } from '../../electron/data/ai/insight-evidence-card'
import { parseInsightEvidenceCard } from '../../electron/main/insight-evidence-card'
import { createMessageProcessor } from '../../electron/main/message-processing'
import { defaultProcessing } from '../../src/shared/settings-contract'

const messages = [
  { id: '11', isSelf: true, text: '这次我来订位。', senderName: '我', sentAtMs: null, revision: 'a', replyToMessageId: null },
  { id: '12', isSelf: false, text: '我把时间发你。', senderName: 'ta', sentAtMs: null, revision: 'b', replyToMessageId: null },
]
const card: InsightEvidenceCard = {
  period: '第二段', events: [{ summary: '确认订位', options: '', selfChoice: '本人订位', counterpartResponse: '对方发时间', messageIds: ['11', '12'] }],
  selfSignals: [{ dimension: 'JP', observation: '本人先确定分工', directionHint: 'J', supportingIds: ['11'], counterexampleIds: ['12'],
    excerpts: [{ messageId: '11', text: '我来订位' }, { messageId: '12', text: '时间发你' }] }],
  riskSignals: [], revisions: [{ targetSegment: 0, kind: 'behavior_change', priorClaim: '此前请对方订位',
    revisedObservation: '本次由本人订位', messageIds: ['1', '11'] }], openThreads: [],
}
const parse = (data: unknown) => parseInsightEvidenceCard(JSON.stringify(data), 1, messages, new Set(['1']))

test('证据卡保留逐字引文和有来源的跨期修正，空的可选列表可省略', () => {
  expect(parse(card)).toEqual(card)
  expect(parse({ ...card, riskSignals: undefined, openThreads: undefined, revisions: undefined })).toEqual({ ...card, revisions: [] })
  expect(parse({ ...card, revisions: [{ ...card.revisions[0], kind: 'added_context', messageIds: ['11'] }] }).revisions[0].kind).toBe('added_context')
})

test.each([
  ['事件引用旧段', { events: [{ ...card.events[0], messageIds: ['1'] }] }],
  ['观察引用范围外原话', { selfSignals: [{ ...card.selfSignals[0], counterexampleIds: ['22'] }] }],
  ['风险事实没有引用', { riskSignals: [{ fact: '威胁', messageIds: [] }] }],
  ['待核实问题引用旧段', { openThreads: [{ text: '待核实', messageIds: ['1'] }] }],
  ['修正引用未来消息', { revisions: [{ ...card.revisions[0], messageIds: ['13'] }] }],
  ['修正指向本段', { revisions: [{ ...card.revisions[0], targetSegment: 1 }] }],
  ['本人观察只有对方的依据', { selfSignals: [{ ...card.selfSignals[0], supportingIds: ['12'], counterexampleIds: [], excerpts: [] }] }],
  ['依据反例重叠', { selfSignals: [{ ...card.selfSignals[0], supportingIds: ['11', '12'] }] }],
  ['摘录编号没有列入本项依据或反例', { selfSignals: [{ ...card.selfSignals[0], counterexampleIds: [] }] }],
  ['引文省略中间文字', { selfSignals: [{ ...card.selfSignals[0], excerpts: [{ messageId: '11', text: '这次订位' }] }] }],
])('%s 会退回证据卡', (_, changes) => {
  expect(() => parse({ ...card, ...changes })).toThrowError(expect.objectContaining({ code: 'INVALID_EVIDENCE' }))
})

test.each([
  { advice: '建议' }, { events: null }, { selfSignals: [{ ...card.selfSignals[0], directionHint: 'I' }] },
  { revisions: [{ ...card.revisions[0], kind: 'guess' }] }, { riskSignals: null }, { openThreads: [{}] },
])('退回含无效字段或格式错误的证据卡 %#', changes => {
  expect(() => parse({ ...card, ...changes })).toThrowError(expect.objectContaining({ code: 'INVALID_INSIGHT_OUTPUT' }))
})

test('模型自行添加的隐私字段也按当前设置处理，保留消息编号', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, redact: true, rules: ['email'] }, [])
  const withAddress = { ...card, events: [{ ...card.events[0], summary: '确认地址 sample@example.invalid' }] }
  const parsed = parseInsightEvidenceCard(JSON.stringify(withAddress), 1, messages, new Set(['1']), processor.data)
  expect(parsed.events).toEqual([{ ...card.events[0], summary: '确认地址 [邮箱]' }])
})
