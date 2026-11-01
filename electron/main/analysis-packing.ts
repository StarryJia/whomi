import type { AiModel } from '../../src/shared/ai-contract'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { resolveModelLimits } from '../../src/shared/model-limits'
import type { createMessageProcessor, ProcessingMessage } from './message-processing'

export type SourceMessage = ProcessingMessage & { isSelf: boolean }
type SourceBatch = { index: number; items: SourceMessage[]; messageIds: string[] }
type Processor = ReturnType<typeof createMessageProcessor>
export type AnalysisStage = 'source' | 'merge' | 'final'
const stageText = { source: '原文分片', merge: '事件归并', final: '文稿撰写' }

export function capacityError(stage: AnalysisStage, upstream = false) {
  const where = upstream ? '模型服务的输入上限' : '本机最大输入长度'
  return new BoundaryError(upstream ? 'MODEL_CONTEXT_LIMIT' : 'CONTEXT_TOO_LARGE', `${stageText[stage]}超出${where}，请选择更大上下文的模型重新生成。`)
}
export function promptBudget(model: AiModel, system: string, history?: unknown) {
  return resolveModelLimits(model).maxInputTokens - 1000 - Buffer.byteLength(system, 'utf8') - Buffer.byteLength(JSON.stringify(history ?? []), 'utf8')
}
export function analysisBudget(model: AiModel) {
  const budget = resolveModelLimits(model).maxInputTokens - 1800
  if (budget < 1) throw new BoundaryError('MODEL_INPUT_TOO_SMALL', '模型最大输入长度不足，请增加最大输入长度或选择更大上下文的模型。')
  return budget
}

// 仅复原 0.1.7 及以前的提交边界。新分片使用完整请求的字节预算。
function legacyBatches(messages: SourceMessage[], model: AiModel) {
  const budget = analysisBudget(model)
  const parts: SourceMessage[][] = [], covered: string[][] = []
  let current: SourceMessage[] = [], size = 0
  const flush = () => { if (current.length) { parts.push(current); covered.push([...new Set(current.flatMap(item => item.sourceIds ?? [item.id]))]); current = []; size = 0 } }
  for (const message of messages) {
    let text = message.text
    do {
      let end = Math.min(text.length, budget)
      while (end > 0 && Buffer.byteLength(JSON.stringify({ ...message, text: text.slice(0, end) }), 'utf8') > budget) end = Math.floor(end * .8)
      // 保持代理对完整，避免把同一个字符拆成两个无效片段。
      if (end > 0 && end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--
      if ((text && end < 1) || Buffer.byteLength(JSON.stringify({ ...message, text: text.slice(0, end) }), 'utf8') > budget) throw new BoundaryError('MODEL_INPUT_TOO_SMALL', '单条消息的发送信息超出最大输入长度，请增加最大输入长度或选择更大上下文的模型。')
      const fragment = { ...message, text: text.slice(0, end) }; text = text.slice(end)
      const cost = Buffer.byteLength(JSON.stringify(fragment), 'utf8')
      if (size + cost > budget) flush()
      current.push(fragment); size += cost
      if (text) flush()
    } while (text)
  }
  flush()
  // 只有最后一个片段提交时，超长原消息才计入已分析覆盖。
  const last = new Map<string, number>()
  covered.forEach((ids, index) => ids.forEach(id => last.set(id, index)))
  return parts.map((items, index) => ({ items, messageIds: covered[index].filter(id => last.get(id) === index), index }))
}

function pack(messages: SourceMessage[], space: number, start: number): SourceBatch[] {
  const result: SourceBatch[] = []
  let items: SourceMessage[] = [], messageIds: string[] = [], used = 0
  function flush() {
    if (items.length) result.push({ items, messageIds, index: start + result.length })
    items = []; messageIds = []; used = 0
  }
  for (const message of messages) {
    let offset = 0
    do {
      let end = Math.min(message.text.length, offset + space)
      const fragment = (stop: number) => ({ ...message, text: message.text.slice(offset, stop) })
      if (Buffer.byteLength(JSON.stringify(fragment(end))) > space) {
        let low = offset, high = end
        while (low < high) {
          const mid = Math.ceil((low + high) / 2)
          if (Buffer.byteLength(JSON.stringify(fragment(mid))) <= space) low = mid
          else high = mid - 1
        }
        end = low
      }
      if (end < message.text.length && end > offset && /[\ud800-\udbff]/.test(message.text[end - 1])) end--
      const item = fragment(end), bytes = Buffer.byteLength(JSON.stringify(item))
      if (bytes > space || (end <= offset && offset < message.text.length)) throw capacityError('source')
      if (items.length && used + 1 + bytes > space) flush()
      used += (items.length ? 1 : 0) + bytes
      items.push(item)
      offset = end
      if (end === message.text.length) messageIds.push(...message.sourceIds ?? [message.id])
      else flush()
    } while (offset < message.text.length)
  }
  flush()
  return result
}

function invalidCheckpoint(): never { throw new BoundaryError('BATCH_CONFLICT', '分片与已有断点不一致，请重新生成。') }

export function planAnalysis(input: { model: AiModel; messages: SourceMessage[]; batches: {index:number; messageIds:string[]}[]; checkpoint: string | null },
  processor: Processor | undefined, budget: number, emptyPayload: unknown) {
  const prepared = processor?.prepare(input.messages) ?? input.messages.map(message => ({ ...message, sourceIds: message.sourceIds ?? [message.id] }))
  const room = budget - Buffer.byteLength(JSON.stringify(emptyPayload))
  if (room < 1) throw capacityError('source')
  const marker = /^source-layout-v1:(\d+)$/.exec(input.checkpoint ?? '')
  let preserve = marker ? Number(marker[1]) : input.batches.length ? undefined : 0
  let prefix: SourceBatch[] = []
  let remaining = prepared
  const creditedLater: string[] = []
  if (preserve !== 0) {
    const legacy = legacyBatches(processor ? processor.merge(prepared, Infinity, true) : input.messages, input.model)
    preserve ??= Math.min(input.batches.length, legacy.length)
    if (preserve > legacy.length || preserve > input.batches.length) invalidCheckpoint()
    prefix = legacy.slice(0, preserve)
    const covered = new Set<string>()
    for (const {index,messageIds} of prefix) {
      const saved = input.batches[index]
      if (saved?.index !== index || JSON.stringify(saved.messageIds) !== JSON.stringify(messageIds)) invalidCheckpoint()
      for (const id of messageIds) covered.add(id)
    }
    remaining = prepared.filter(item => !covered.has(item.id))
    // 旧格式把跨片合并消息的全部编号记在最后一片；还原已保存的原文字数以免重复发送。
    const partial = legacy[preserve]?.items[0]
    if (partial && prefix.at(-1)?.items.at(-1)?.id === partial.id) {
      let consumed = 0
      for (const batch of prefix) for (const item of batch.items) if (item.id === partial.id) consumed += item.text.length
      const groupIds = new Set(partial.sourceIds ?? [partial.id])
      remaining = remaining.flatMap(item => {
        if (!consumed || !groupIds.has(item.id)) return [item]
        if (consumed < item.text.length) {
          const suffix = { ...item, text: item.text.slice(consumed) }
          consumed = 0
          return [suffix]
        }
        consumed = Math.max(0, consumed - item.text.length - 1)
        creditedLater.push(item.id)
        return []
      })
    }
  }
  const plan = prefix.concat(pack(processor ? processor.merge(remaining, room) : remaining, room, prefix.length))
  if (creditedLater.length) {
    if (!plan[prefix.length]) invalidCheckpoint()
    plan[prefix.length].messageIds = creditedLater.concat(plan[prefix.length].messageIds)
  }
  for (const batch of input.batches.slice(prefix.length, plan.length)) {
    if (JSON.stringify(plan[batch.index]?.messageIds) !== JSON.stringify(batch.messageIds)) invalidCheckpoint()
  }
  return { plan, checkpoint: 'source-layout-v1:' + prefix.length, legacySummary: prefix.length > 0 && prefix.length === plan.length }
}
