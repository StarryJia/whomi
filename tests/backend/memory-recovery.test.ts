import { expect, test } from 'vitest'
import { generateMemory } from '../../electron/main/memory-generation'
import { memoryRecovery, type MemoryCheckpoint } from '../../electron/main/memory-recovery'
import type { MemoryNotes } from '../../electron/data/ai/memory-notes'
import { BoundaryError } from '../../src/shared/desktop-validation'

function fixture(count: number, length = 500) {
  const source = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), text: 'source', kind: 'text', isSelf: true, senderName: '本人', memberId: '1', sentAtMs: i }))
  const plan = source.map((item, index) => ({ index, items: [item], messageIds: [item.id] }))
  const saved = source.map((item, index) => ({ index, report: { events: [{ key: item.id, text: 'x'.repeat(length), evidenceMessageIds: [item.id], signals: [] }] } as MemoryNotes }))
  let checkpoint = JSON.stringify({ format: 'memory-adaptive-v1', layout: 'source-layout-v1:0', sourceBudget: 4000, sourceCount: count, nextIndex: count, legacyEnd: count - 1, nodes: {} } satisfies MemoryCheckpoint)
  const recovery = () => memoryRecovery(JSON.parse(checkpoint), async value => { checkpoint = value })
  const save = async (index: number, _ids: string[], report: MemoryNotes) => { saved.push({ index, report }) }
  return { source, plan, saved, save, recovery }
}
const response = (value: unknown) => ({ text: JSON.stringify(value), usage: {} })
const final = (events: { key: string }[]) => response({ groups: events.map(event => [event.key]), events: [{ key: '1', title: '示例', text: '共同安排。' }], relationship: '一起商量。' })

test('merge overflow splits only the rejected group and reuses its saved child after restart', async () => {
  const f = fixture(6), seen: string[] = []
  let offline = true
  const run = () => generateMemory({ ...f, recovery: f.recovery(), scored: true, budget: 600, mergeBudget: 1200, sourceBudget: 4000,
    signal: new AbortController().signal, summarizing: async () => {}, request: async (_index, _system, raw, stage) => {
      const events = (raw as { events: { key: string }[] }).events
      if (stage === 'final') return final(events)
      const keys = events.map(event => event.key).join(','); seen.push(keys)
      if (events.length > 1) throw new BoundaryError('MODEL_OUTPUT_LIMIT', '示例超限')
      if (keys === '2' && offline) throw Error('offline')
      return response({ groups: [[keys]], events: [{ key: keys, text: 'ok-' + keys }] })
    } })
  await expect(run()).rejects.toThrow('offline')
  expect(seen).toEqual(['1,2', '1', '2'])
  offline = false
  const report = await run()
  expect(seen.slice(3)).toEqual(['2', '3,4', '3', '4', '5,6', '5', '6'])
  expect(report.events).toEqual([{ title: '示例', text: '共同安排。' }])
  expect(new Set(f.saved.map(batch => batch.index)).size).toBe(f.saved.length)
})

test('final output overflow compacts saved material before retrying the manuscript', async () => {
  const f = fixture(2, 300), stages: string[] = [], sizes: number[] = []
  const report = await generateMemory({ ...f, recovery: f.recovery(), scored: true, budget: 1000, mergeBudget: 1000, sourceBudget: 4000,
    signal: new AbortController().signal, summarizing: async () => {}, request: async (_index, _system, raw, stage) => {
      const events = (raw as { events: { key: string }[] }).events
      stages.push(stage)
      if (stage === 'final') {
        sizes.push(JSON.stringify(raw).length)
        if (sizes.length === 1) throw new BoundaryError('MODEL_OUTPUT_LIMIT', '示例超限')
        return final(events)
      }
      return response({ groups: events.map(event => [event.key]), events: events.map(event => ({ key: event.key, text: '缩写' })) })
    } })
  expect(stages).toEqual(['final', 'merge', 'final'])
  expect(sizes[1]).toBeLessThan(sizes[0])
  expect(report.events).toHaveLength(1)
})


test('source shrinking preserves Unicode, merged identifiers and coverage only at the final fragment', async () => {
  const f = fixture(1), text = 'a' + '😀'.repeat(128)
  const message = { ...f.source[0], text, sourceIds: ['1', '2'] }
  const fragments: string[] = [], coverage: string[][] = []
  await generateMemory({ ...f, saved: [], plan: [{ index: 0, items: [message], messageIds: ['1', '2'] }], recovery: f.recovery(),
    scored: true, budget: 4000, sourceBudget: 4000, signal: new AbortController().signal, summarizing: async () => {},
    save: async (_index, ids) => { coverage.push(ids) }, request: async (_index, _system, raw, stage) => {
      if (stage === 'final') return final([{ key: '1' }])
      const item = (raw as { messages: typeof message[] }).messages[0]
      if (item.text.length > 130) throw new BoundaryError('MODEL_OUTPUT_LIMIT', '示例超限')
      fragments.push(item.text)
      return response({ events: [{ key: '1', text: '一起商量。', evidenceMessageIds: item.sourceIds, signals: [] }] })
    } })
  expect(fragments.join('')).toBe(text)
  expect(fragments.every(part => part.isWellFormed())).toBe(true)
  expect(coverage).toEqual([[], ['1', '2']])
})

test.each(['INVALID_MEMORY', 'MODEL_REQUEST_FAILED', 'ACCOUNT_ACCESS'])('does not shrink or retry non-capacity failure %s', async code => {
  const f = fixture(1), calls: number[] = []
  await expect(generateMemory({ ...f, saved: [], recovery: f.recovery(), scored: true, budget: 4000, sourceBudget: 4000,
    signal: new AbortController().signal, summarizing: async () => {}, request: async index => {
      calls.push(index)
      throw new BoundaryError(code, '合成错误')
    } })).rejects.toMatchObject({ code })
  expect(calls).toHaveLength(1)
})

test('cancellation after a split child is saved resumes without replaying that child', async () => {
  const f = fixture(1), controller = new AbortController()
  const plan = [{ index: 0, items: [{ ...f.source[0], text: 'a'.repeat(128) + 'b'.repeat(128) }], messageIds: ['1'] }]
  const saved: typeof f.saved = [], seen: string[] = []
  const request = async (_index: number, _system: string, raw: unknown, stage: string) => {
    if (stage === 'final') return final([{ key: '1' }])
    const item = (raw as { messages: { text: string }[] }).messages[0]
    seen.push(item.text)
    if (item.text.length > 128) throw new BoundaryError('MODEL_OUTPUT_LIMIT', '示例超限')
    return response({ events: [{ key: '1', text: item.text, evidenceMessageIds: ['1'], signals: [] }] })
  }
  const run = (signal: AbortSignal) => generateMemory({ ...f, plan, saved, recovery: f.recovery(), scored: true, budget: 4000, sourceBudget: 4000,
    signal, summarizing: async () => {}, request, save: async (index, _ids, report) => { saved.push({ index, report }); controller.abort() } })
  await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(saved).toHaveLength(1)
  await run(new AbortController().signal)
  expect(seen).toEqual(['a'.repeat(128) + 'b'.repeat(128), 'a'.repeat(128), 'b'.repeat(128)])
})

test('final retry decisions and completed compaction nodes survive interruption', async () => {
  const f = fixture(2, 300), calls: string[] = []
  let offline = true
  const run = () => generateMemory({ ...f, recovery: f.recovery(), scored: true, budget: 1000, mergeBudget: 1000, sourceBudget: 4000,
    signal: new AbortController().signal, summarizing: async () => {}, request: async (_index, _system, raw, stage) => {
      const events = (raw as { events: { key: string; text: string }[] }).events
      calls.push(stage + ':' + events[0].text.length)
      if (stage === 'final') {
        if (events[0].text.length === 300) throw new BoundaryError('MODEL_OUTPUT_LIMIT', '示例超限')
        if (offline) throw Error('offline')
        return final(events)
      }
      return response({ groups: events.map(event => [event.key]), events: events.map(event => ({ key: event.key, text: '缩写' })) })
    } })
  await expect(run()).rejects.toThrow('offline')
  offline = false
  await run()
  expect(calls).toEqual(['final:300', 'merge:300', 'final:2', 'final:2'])
})
