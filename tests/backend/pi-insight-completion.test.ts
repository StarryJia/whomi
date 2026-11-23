import { expect, test } from 'vitest'
import { generatePiInsight, type PiInsightCheckpoint } from '../../electron/main/pi-insight-generation'
import { defaultInsightPrompts } from '../../electron/data/ai/insight-prompts'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { aiOperation } from '../../electron/main/ai-operation-diagnostics'

const snapshot = { taskId: '7', scope: { kind: 'all' as const }, timezone: 'UTC', sourceStartTimeMs: null, sourceEndTimeMs: null,
  createdAtMs: 0, sources: [{ messageId: '11', revision: 'a'.repeat(64) }] }
const options = { snapshot, conversationId: '2', thinkingLevel: undefined, prompts: defaultInsightPrompts, processing: defaultProcessing,
  checkpoint: null, signal: new AbortController().signal, operation: aiOperation(undefined, 'insight', 'generate'),
  model: { id: 'm', model: 'local', label: '本机模拟', baseUrl: 'http://localhost', enabled: true, hasCredential: false, version: 1, contextWindow: 16000, maxTokens: 800 },
  read: async () => [{ id: '11', revision: 'a'.repeat(64), text: '周三一起约。', senderName: '我', isSelf: true, sentAtMs: 0, replyToMessageId: null }] }
const section = [{ content: [{ text: '一起约', citationId: 'c' }] }]
const draft = { aboutYou: section, relationship: section, citations: [{ id: 'c', fragments: [{ messageIds: ['11'] }] }], limitations: [] }

test('提前交稿和坏引用可在同一会话修正，重试保存沿用已校验的正文', async () => {
  let saved: PiInsightCheckpoint | null = null
  const save = async (state: PiInsightCheckpoint) => { saved = structuredClone(state) }
  const requests: (string | null | undefined)[] = []
  await expect(generatePiInsight({ ...options, save, run: async (input, io) => {
    requests.push(input.checkpoint)
    if (requests.length === 1) return { text: JSON.stringify(draft), checkpoint: 'first', usage: {} }
    expect(input.prompt).toContain('resumeCursor')
    const page = await io.read({}, 2000)
    await io.record({ type: 'requestStart', requestId: 'r', kind: 'inference' })
    await io.record({ type: 'request', requestId: 'r', kind: 'inference', spans: page.spans, success: true, usage: { inputTokens: 100 }, checkpoint: 'second' })
    return { text: JSON.stringify({ ...draft, citations: [{ id: 'c', fragments: [{ messageIds: ['12'] }] }] }), checkpoint: 'bad-report', usage: {} }
  } })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  expect(requests).toEqual([null, 'first'])
  expect(saved).toMatchObject({ coverage: { coveredMessageIds: ['11'] }, input: 100, checkpoint: 'bad-report' })
  const fixed = await generatePiInsight({ ...options, checkpoint: saved, save, run: async input => {
    expect(input.checkpoint).toBe('bad-report')
    return { text: JSON.stringify(draft), checkpoint: 'corrected', usage: {} }
  } })
  expect(fixed.aboutYou).toEqual(section)
  expect(await generatePiInsight({ ...options, checkpoint: saved, save, run: () => { throw Error('unexpected model request') } })).toEqual(fixed)
})

test('超长原文恢复从已确认的连续前缀之后取文', async () => {
  const checkpoint: PiInsightCheckpoint = { version: 'pi-insight-v1', taskId: '7', checkpoint: 'leaf', processing: defaultProcessing,
    requests: 2, stalled: 0, input: 60, output: 3, coverage: { coveredMessageIds: [], partial: { '11': [[0, 2], [4, 5]] } } }
  await expect(generatePiInsight({ ...options, checkpoint, save: async () => {}, run: async (input, io) => {
    const { resumeCursor } = JSON.parse(input.prompt.slice(input.prompt.indexOf('{')))
    const result = await io.read({ cursor: resumeCursor }, 2000)
    expect(result.page).toMatchObject({ status: 'ok', messages: [{ text: '一起约。', fragment: { start: 2 } }] })
    throw new Error('模拟服务离线')
  } })).rejects.toThrow('模拟服务离线')
})
