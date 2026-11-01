import type { AiUsage } from '../../src/shared/ai-contract'
import { collectEvents, finishMemory, memoryFinalPrompt, memoryMergePrompt, memorySourcePrompt, modelJson, readNotes, type MemoryEvent, type MemoryNotes } from '../data/ai/memory-notes'
import type { ProcessingMessage } from './message-processing'
import { capacityError, type AnalysisStage } from './analysis-packing'
import { compactScoredEvents, finishScoredMemory, scoredFinalPrompt, scoredMergePrompt, scoredSourcePrompt } from '../data/ai/memory-scoring'

type Source = ProcessingMessage & { isSelf: boolean }
type Persisted = { index: number; report: MemoryNotes }
type Request = (index: number, system: string, payload: unknown, stage: AnalysisStage) => Promise<{ text: string; usage: AiUsage }>
type Save = (index: number, messageIds: string[], report: MemoryNotes, usage: AiUsage) => Promise<void>
type Input = {
  plan: { index: number; items: Source[]; messageIds: string[] }[]; scored: boolean
  saved: Persisted[]; source: Source[]; budget: number; sourceBudget: number
  request: Request; save: Save; clean?: (notes: MemoryNotes) => MemoryNotes; summarizing: () => Promise<void>; signal: AbortSignal
}

export async function generateMemory({ plan, saved, source, budget, sourceBudget, request, save, clean, summarizing, signal, scored }: Input) {
  const previous = new Map(saved.map(node => [node.index, node.report]))
  const notes: MemoryNotes[] = []
  const knownEvents = new Set<string>()
  for (const batch of plan) {
    signal.throwIfAborted()
    let note = previous.get(batch.index)
    if (!note) {
      const payload: { messages: Source[]; knownEvents: string[] } = { messages: batch.items, knownEvents: [] }
      let remaining = sourceBudget - Buffer.byteLength(JSON.stringify(payload))
      for (const key of [...knownEvents].reverse()) {
        const size = Buffer.byteLength(JSON.stringify(key)) + 1
        if (size > remaining) continue
        payload.knownEvents.push(key)
        remaining -= size
      }
      const response = await request(batch.index, scored ? scoredSourcePrompt : memorySourcePrompt, payload, 'source')
      signal.throwIfAborted()
      const ids = (message: Source) => message.sourceIds ?? [message.id]
      note = readNotes(modelJson(response.text), new Set(batch.items.flatMap(ids)), new Set(batch.items.filter(item => item.isSelf).flatMap(ids)))
      if (clean) note = clean(note)
      await save(batch.index, batch.messageIds, note, response.usage)
    }
    notes.push(note)
    for (const event of note.events) { knownEvents.delete(event.key); knownEvents.add(event.key) }
  }
  signal.throwIfAborted()
  await summarizing()
  const tooLarge = () => capacityError('merge')
  const payload = (events: MemoryEvent[]) => ({ events: scored ? events.map(event => ({ key: event.key, text: event.text, messageCount: event.evidenceMessageIds.length })) : events })
  const bytes = (events: MemoryEvent[]) => Buffer.byteLength(JSON.stringify(payload(events)), 'utf8')
  let material = collectEvents(notes)
  let nextIndex = plan.length
  // 分层归并沿用稳定的节点编号，暂停后可复用已提交的归并结果。
  for (let level = 0; bytes(material) > budget; level++) {
    if (level >= 8) throw tooLarge()
    const groups: MemoryEvent[][] = []
    let group: MemoryEvent[] = []
    // 跨分片的长经历先按原始片段压缩，再在下一层重新归并。
    const inputs = level === 0 && !scored ? notes.flatMap(note => note.events) : material
    for (const event of inputs) {
      if (bytes([event]) > budget) throw tooLarge()
      if (group.length && bytes([...group, event]) > budget) { groups.push(group); group = [] }
      group.push(event)
    }
    if (group.length) groups.push(group)
    const smaller: MemoryNotes[] = []
    for (const events of groups) {
      signal.throwIfAborted()
      const index = nextIndex++
      let note = previous.get(index)
      if (!note) {
        const response = await request(index, scored ? scoredMergePrompt : memoryMergePrompt, payload(events), 'merge')
        signal.throwIfAborted()
        if (scored) note = { events: compactScoredEvents(modelJson(response.text), events) }
        else {
          const signals = events.flatMap(event => event.signals)
          note = readNotes(modelJson(response.text), new Set(events.flatMap(event => event.evidenceMessageIds)), new Set(signals.map(item => item.messageId)))
          for (const event of note.events) {
            event.signals = event.signals.filter(item => signals.some(origin => origin.messageId === item.messageId && origin.direction === item.direction))
          }
        }
        if (clean) note = clean(note)
        await save(index, [], note, response.usage)
      }
      smaller.push(note)
    }
    const reduced = collectEvents(smaller)
    if (bytes(reduced) >= bytes(material)) throw tooLarge()
    material = reduced
  }
  const final = await request(nextIndex, scored ? scoredFinalPrompt : memoryFinalPrompt, payload(material), 'final')
  signal.throwIfAborted()
  const order = new Map(source.map((message, index) => [message.id, index]))
  return (scored ? finishScoredMemory : finishMemory)(modelJson(final.text), material, order)
}
