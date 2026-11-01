import { expect, test } from 'vitest'
import { collectEvents, finishMemory, readNotes } from '../../electron/data/ai/memory-notes'

const empty = { EI: null, SN: null, TF: null, JP: null }
const event = { key: '周末计划', text: '两人在聊周末怎么安排。', evidenceMessageIds: ['1', '2'], signals: [{ direction: 'J', messageId: '1' }, { direction: 'E', messageId: '2' }] }
const draft = { dimensions: { EI: 'E', SN: null, TF: null, JP: 'J' }, events: [{ key: '周末计划', title: '周末计划', text: '两人定下了周末的安排。' }], relationship: '两人似乎愿意互相配合。' }
const order = new Map([['1', 0], ['2', 1]])

test('swapping the confirmed self changes which authored signals can support a prediction', () => {
  const allowed = new Set(order.keys())
  for (const [self, dims] of [['1', { ...empty, JP: 'J' }], ['2', { ...empty, EI: 'E' }], [null, empty]] as const) {
    const note = readNotes({ events: [event] }, allowed, new Set(self ? [self] : []))
    const report = finishMemory(structuredClone(draft), collectEvents([note]), order)
    expect(report.dimensions).toEqual(dims)
    expect(report.events).toEqual([{ title: '周末计划', text: '两人定下了周末的安排。' }])
    expect(JSON.stringify(report)).not.toMatch(/messageId|evidence|signals/)
  }
})

test('duplicate checkpoints do not add volume and overlapping manuscript events must be corrected', () => {
  const material = collectEvents([{ events: [event] }, { events: [{ ...event, text: '后来订了票。' }] }])
  expect(material).toHaveLength(1)
  expect(material[0]).toMatchObject({ evidenceMessageIds: ['1', '2'], text: '两人在聊周末怎么安排。\n后来订了票。' })
  expect(() => finishMemory({ ...draft, events: [...draft.events, ...draft.events] }, material, order)).toThrow()
  expect(() => finishMemory({ ...draft, events: [] }, material, order)).toThrow()
  expect(() => readNotes({ events: [{ ...event, evidenceMessageIds: ['3'] }] }, new Set(order.keys()), new Set(['1']))).toThrow()
})

test('declared aliases cannot be reused, but separate events can share a source message', () => {
  const alias = { ...event, key: '周六车票', text: '后来订了车票。', evidenceMessageIds: ['2'] }
  const other = { ...event, key: '讨论课', text: '这条消息还约了讨论课。' }
  const notes = collectEvents([{ events: [event, alias, other] }])
  const weekend = { ...draft.events[0], alsoKeys: [alias.key] }
  const lesson = { key: other.key, title: '讨论课', text: other.text }
  expect(finishMemory({ ...draft, events: [weekend, lesson] }, notes, order).events).toHaveLength(2)
  expect(() => finishMemory({ ...draft, events: [weekend, { ...lesson, key: alias.key }] }, notes, order)).toThrow()
})
