import { createHash } from 'node:crypto'
import type { AiUsage } from '../../src/shared/ai-contract'
import { collectEvents, finishMemory, memoryFinalPrompt, memoryMergePrompt, memorySourcePrompt, modelJson, readNotes, type MemoryEvent, type MemoryNotes } from '../data/ai/memory-notes'
import type { ProcessingMessage } from './message-processing'
import { capacityError, type AnalysisStage } from './analysis-packing'
import { compactScoredEvents, finishScoredMemory, finishExplainedMemory, explainedFinalPrompt, explainedMergePrompt, explainedSourcePrompt, scoredFinalPrompt, scoredMergePrompt, scoredSourcePrompt } from '../data/ai/memory-scoring'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { isMemoryCapacityError, splitSource, type MemoryRecovery } from './memory-recovery'

type Source = ProcessingMessage & { isSelf: boolean }
type Persisted = { index: number; report: MemoryNotes }
type Request = (index: number, system: string, payload: unknown, stage: AnalysisStage) => Promise<{ text: string; usage: AiUsage }>
type Save = (index: number, messageIds: string[], report: MemoryNotes, usage: AiUsage) => Promise<void>
type Input = {
  recovery?: MemoryRecovery
  prompts?: { source: string; merge: string; final: string }
  plan: { index: number; items: Source[]; messageIds: string[] }[]; scored: boolean; explained?: boolean
  saved: Persisted[]; source: Source[]; budget: number; mergeBudget?: number; sourceBudget: number
  request: Request; save: Save; clean?: <T>(value: T) => T; summarizing: () => Promise<void>; signal: AbortSignal
}

export async function generateMemory({ recovery, plan, saved, source, budget, mergeBudget = budget, sourceBudget, request, save, clean, summarizing, signal, scored, explained = false, prompts }: Input) {
  const previous = new Map(saved.map(node => [node.index, node.report]))
  const notes: MemoryNotes[] = []
  const knownEvents = new Set<string>()
  async function sourceNode(batch: Input['plan'][number], key: string, depth = 0): Promise<void> {
    signal.throwIfAborted()
    const node = recovery ? await recovery.node(key, depth === 0 ? batch.index : undefined) : { index: batch.index, split: false }
    const children = () => splitSource(batch)
    const descend = async (parts: NonNullable<ReturnType<typeof splitSource>>) => {
      for (const [part, child] of parts.entries()) await sourceNode({ ...child, index: node.index }, key + '/' + part, depth + 1)
    }
    if (node.split) {
      const parts = children()
      if (!parts) throw capacityError('source')
      await descend(parts)
      return
    }
    let note = previous.get(node.index)
    if (!note) {
      const payload: { messages: Source[]; knownEvents: string[] } = { messages: batch.items, knownEvents: [] }
      // 缩片同时缩减已知事件提示，避免辅助信息占满刚刚释放的空间。
      let remaining = Math.min(sourceBudget - Buffer.byteLength(JSON.stringify(payload)), Math.floor(Buffer.byteLength(JSON.stringify(payload)) / 4))
      for (const key of [...knownEvents].reverse()) {
        const size = Buffer.byteLength(JSON.stringify(key)) + 1
        if (size > remaining) continue
        payload.knownEvents.push(key)
        remaining -= size
      }
      let response: Awaited<ReturnType<Request>>
      try {
        response = await request(node.index, prompts?.source ?? (explained ? explainedSourcePrompt : scored ? scoredSourcePrompt : memorySourcePrompt), payload, 'source')
      } catch (error) {
        signal.throwIfAborted()
        const parts = recovery && isMemoryCapacityError(error) && depth < 8 ? children() : undefined
        if (!parts) throw error
        await recovery!.split(key)
        await descend(parts)
        return
      }
      signal.throwIfAborted()
      const ids = (message: Source) => message.sourceIds ?? [message.id]
      note = readNotes(modelJson(response.text), new Set(batch.items.flatMap(ids)), new Set(batch.items.filter(item => item.isSelf).flatMap(ids)))
      if (clean) note = clean(note)
      await save(node.index, batch.messageIds, note, response.usage)
    }
    notes.push(note)
    for (const event of note.events) { knownEvents.delete(event.key); knownEvents.add(event.key) }
  }
  for (const batch of plan) await sourceNode(batch, 'source:' + batch.index)
  signal.throwIfAborted()
  await summarizing()
  const tooLarge = () => capacityError('merge')
  const payload = (events: MemoryEvent[]) => ({ events: scored ? events.map(event => ({ key: event.key, text: event.text, messageCount: event.evidenceMessageIds.length,
    ...(explained ? { signals: event.signals } : {}) })) : events })
  const bytes = (events: MemoryEvent[]) => Buffer.byteLength(JSON.stringify(payload(events)), 'utf8')
  const identity = (events: MemoryEvent[]) => createHash('sha256').update(JSON.stringify(events)).digest('hex')
  async function mergeNode(events: MemoryEvent[], key: string, originalIndex?: number, depth = 0): Promise<MemoryNotes[]> {
    signal.throwIfAborted()
    const node = recovery ? await recovery.node(key, originalIndex !== undefined && originalIndex <= recovery.state.legacyEnd ? originalIndex : undefined) : { index: originalIndex!, split: false }
    const saved = previous.get(node.index)
    if (saved) return [saved]
    const parts = () => {
      if (events.length > 1) { const mid = Math.ceil(events.length / 2); return [events.slice(0, mid), events.slice(mid)] }
      const event = events[0]
      if (!event || event.text.length < 128) return
      let mid = Math.floor(event.text.length / 2)
      if (/[\ud800-\udbff]/.test(event.text[mid - 1])) mid--
      return [[{ ...event, text: event.text.slice(0, mid) }], [{ ...event, text: event.text.slice(mid) }]]
    }
    const descend = async (groups: MemoryEvent[][]) => {
      const result: MemoryNotes[] = []
      for (const [part, group] of groups.entries()) result.push(...await mergeNode(group, key + '/' + part, undefined, depth + 1))
      return result
    }
    if (node.split) {
      const groups = parts()
      if (!groups) throw tooLarge()
      return descend(groups)
    }
    let response: Awaited<ReturnType<Request>>
    try {
      if (bytes(events) > mergeBudget) throw tooLarge()
      response = await request(node.index, prompts?.merge ?? (explained ? explainedMergePrompt : scored ? scoredMergePrompt : memoryMergePrompt), payload(events), 'merge')
    } catch (error) {
      signal.throwIfAborted()
      const groups = recovery && isMemoryCapacityError(error) && depth < 8 ? parts() : undefined
      if (!groups) throw error
      await recovery!.split(key)
      return descend(groups)
    }
    signal.throwIfAborted()
    let note: MemoryNotes
    if (scored) note = { events: compactScoredEvents(modelJson(response.text), events) }
    else {
      const signals = events.flatMap(event => event.signals)
      note = readNotes(modelJson(response.text), new Set(events.flatMap(event => event.evidenceMessageIds)), new Set(signals.map(item => item.messageId)))
      for (const event of note.events) {
        event.signals = event.signals.filter(item => signals.some(origin => origin.messageId === item.messageId && origin.direction === item.direction))
      }
    }
    if (clean) note = clean(note)
    await save(node.index, [], note, response.usage)
    return [note]
  }
  let material = collectEvents(notes)
  let nextIndex = plan.length, level = 0
  let finalFailure: unknown
  const order = new Map(source.map((message, index) => [message.id, index]))
  for (let round = 0; ; round++) {
    // 归并编号与输入绑定，避免缩片后误复用另一个分组的旧结果。
    while (bytes(material) > budget) {
      if (level >= 8) throw tooLarge()
      const groups: MemoryEvent[][] = []
      let group: MemoryEvent[] = []
      const inputs = level === 0 && !scored ? notes.flatMap(note => note.events) : material
      for (const event of inputs) {
        if (group.length && bytes([...group, event]) > mergeBudget) { groups.push(group); group = [] }
        group.push(event)
      }
      if (group.length) groups.push(group)
      const smaller: MemoryNotes[] = []
      for (const events of groups) {
        const index = nextIndex++
        smaller.push(...await mergeNode(events, 'merge:' + index + ':' + identity(events), index))
      }
      const reduced = collectEvents(smaller)
      if (bytes(reduced) >= bytes(material)) throw finalFailure ?? tooLarge()
      material = reduced
      level++
    }
    const key = 'final:' + identity(material)
    const node = recovery ? await recovery.node(key) : { index: nextIndex, split: false }
    if (!node.split) {
      try {
        for (let attempt = 0; ; attempt++) {
          const final = await request(node.index + (recovery ? 0 : attempt), prompts?.final ?? (explained ? explainedFinalPrompt : scored ? scoredFinalPrompt : memoryFinalPrompt), payload(material), 'final')
          signal.throwIfAborted()
          try {
            const report = (explained ? finishExplainedMemory : scored ? finishScoredMemory : finishMemory)(modelJson(final.text), material, order)
            return explained && clean ? clean(report) : report
          } catch (error) {
            if (!explained || attempt >= 1 || !(error instanceof BoundaryError) || !['INVALID_MEMORY', 'INVALID_RESPONSE'].includes(error.code)) throw error
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        if (!recovery || !isMemoryCapacityError(error) || round >= 3 || !material.length) throw error
        finalFailure = error
        await recovery.split(key)
      }
    }
    // 成稿不能丢弃事件；先压缩已有材料，再重试，断点记录失败决策以免重复请求。
    budget = Math.min(budget, Math.floor(bytes(material) / 2))
  }
}
