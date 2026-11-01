import { expect, test } from 'vitest'
import { generateMemory } from '../../electron/main/memory-generation'
import { createMessageProcessor } from '../../electron/main/message-processing'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { validateAiResult } from '../../src/shared/ai-validation'
import type { MemoryNotes } from '../../electron/data/ai/memory-notes'

// 以下经历、原文及模型回答均为合成夹具。
const source = ['先订好搬家的货车。', '后来确认了同一辆货车。', '看展前我先订票。', '试讲我想临场发挥。'].map((text, i) => ({
  id: String(i + 1), text, isSelf: true, kind: 'text', senderName: '本人',
}))
const keys = ['搬家', '约货车', '看展', '试讲']
const final = {
  groups: [['搬家', '约货车'], ['看展'], ['试讲']],
  events: [{ key: '搬家', title: '一起搬家', text: '你先订好了货车。' }], relationship: '你们一起准备。',
  dimensionExplanations: { EI: null, SN: null, TF: null, JP: { text: '搬家时你先订车，看展也提前订票；这几次你倾向先安排好。', eventKeys: ['搬家', '看展'] } },
}

async function generate(responses: unknown[] = [final], saved: { index: number; report: MemoryNotes }[] = [], clean?: <T>(value: T) => T) {
  const calls: { index: number; stage: string; payload: any }[] = []
  const committed: { index: number; report: MemoryNotes }[] = []
  let attempt = 0
  const input = {
    plan: source.map((item, index) => ({ index, items: [item], messageIds: [item.id] })), source,
    saved, budget: 10000, sourceBudget: 10000, scored: true, explained: true, clean,
    signal: new AbortController().signal, summarizing: async () => {},
    save: async (index: number, _ids: string[], report: MemoryNotes) => { committed.push({ index, report }) },
    request: async (index: number, _system: string, payload: any, stage: string) => {
      calls.push({ index, stage, payload })
      if (stage === 'source') {
        const id = payload.messages[0].id
        return { text: JSON.stringify({ events: [{ key: keys[Number(id) - 1], text: payload.messages[0].text,
          evidenceMessageIds: [id], signals: [{ direction: id === '4' ? 'P' : 'J', messageId: id }] }] }), usage: {} }
      }
      const response = responses[Math.min(attempt++, responses.length - 1)]
      if (response instanceof Error) throw response
      return { text: typeof response === 'string' ? response : JSON.stringify(response), usage: {} }
    },
  }
  return { report: await generateMemory(input), calls, committed }
}

test('source batches preserve attributed signals through alias grouping into a validated contextual explanation', async () => {
  const { report, calls } = await generate()
  expect(report).toMatchObject({ format: 'memory-v4', dimensions: { EI: null, SN: null, TF: null, JP: 'J' }, eventVotes: { JP: [2, 1] },
    dimensionExplanations: { EI: null, SN: null, TF: null, JP: { text: final.dimensionExplanations.JP.text, evidenceMessageIds: ['1', '2', '3'] } } })
  expect(calls.at(-1)?.payload.events[0]).toMatchObject({ signals: [{ direction: 'J', messageId: '1' }] })
  expect(() => validateAiResult('getReport', report)).not.toThrow()
})

test.each([
  'invalid json',
  { ...final, dimensionExplanations: { ...final.dimensionExplanations, JP: { text: '你临场发挥。', eventKeys: ['试讲'] } } },
  { ...final, dimensionExplanations: { ...final.dimensionExplanations, JP: { text: '你先订好货车。', eventKeys: ['约货车'] } } },
  { ...final, dimensionExplanations: { ...final.dimensionExplanations, EI: { text: '你喜欢社交。', eventKeys: ['搬家'] } } },
  { ...final, dimensionExplanations: { ...final.dimensionExplanations, JP: null } },
])('invalid final explanations get one bounded retry without rereading saved source', async invalid => {
  const saved = (await generate()).committed
  const { report, calls } = await generate([invalid, final], saved)
  expect(report.format).toBe('memory-v4')
  expect(calls.map(call => call.stage)).toEqual(['final', 'final'])
  expect(calls[0].index).not.toBe(calls[1].index)
})

test('repeated invalid output and transport errors fail without manufacturing explanation text', async () => {
  await expect(generate([{ ...final, dimensionExplanations: {} }])).rejects.toHaveProperty('code', 'INVALID_MEMORY')
  await expect(generate([Object.assign(Error('unavailable'), { code: 'MODEL_CONTEXT_LIMIT' })])).rejects.toHaveProperty('code', 'MODEL_CONTEXT_LIMIT')
})

test('multi-level event compression retains self signals for final scoring and explanations', async () => {
  const saved = (await generate()).committed.map(node => ({ ...node, report: { events: node.report.events.map(event => ({ ...event, text: event.text.repeat(20) })) } }))
  const stages: string[] = []
  const result = await generateMemory({ plan: source.map((item, index) => ({ index, items: [item], messageIds: [item.id] })), source,
    saved, scored: true, explained: true, budget: 1800, sourceBudget: 10000, signal: new AbortController().signal,
    summarizing: async () => {}, save: async () => {}, request: async (_index, _system, payload: any, stage) => {
      stages.push(stage)
      expect(payload.events.every((event: { signals: unknown[] }) => event.signals.length)).toBe(true)
      return { text: JSON.stringify(stage === 'merge' ? { groups: payload.events.map((event: { key: string }) => [event.key]), events: payload.events.map((event: { key: string }) => ({ key: event.key, text: '本人选择的事件进展。' })) } : final), usage: {} }
    } })
  expect(stages).toContain('merge')
  expect(result).toMatchObject({ format: 'memory-v4', eventVotes: { JP: [2, 1] }, dimensionExplanations: { JP: { evidenceMessageIds: ['1', '2', '3'] } } })
})

test('unknown axes cannot acquire explanations by borrowing repeated messages as independent events', async () => {
  const saved = (await generate()).committed.map(node => ({ ...node, report: { events: node.report.events.map(event => ({ ...event,
    signals: event.signals.map(signal => ({ ...signal, messageId: signal.direction === 'J' ? '1' : signal.messageId })) })) } }))
  await expect(generate([final], saved)).rejects.toHaveProperty('code', 'INVALID_MEMORY')
})

test('final explanations pass the same anonymization and redaction as source material', async () => {
  const processor = createMessageProcessor({ ...defaultProcessing, anonymize: true, redact: true, rules: ['email'] }, [{ id: '1', displayName: '小林' }])
  const sensitive = { ...final, dimensionExplanations: { ...final.dimensionExplanations,
    JP: { text: '小林先订车，邮箱是 sample@example.com。', eventKeys: ['搬家'] } } }
  const { report } = await generate([sensitive], [], processor.data)
  expect(report).toMatchObject({ dimensionExplanations: { JP: { text: 'U1先订车，邮箱是 [邮箱]。', evidenceMessageIds: ['1', '2'] } } })
  expect(JSON.stringify(report)).not.toMatch(/sample@example|小林/)
})
