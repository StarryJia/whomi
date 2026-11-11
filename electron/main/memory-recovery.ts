import { BoundaryError } from '../../src/shared/desktop-validation'
import type { AiModel } from '../../src/shared/ai-contract'
import { resolveModelLimits } from '../../src/shared/model-limits'
import type { SourceMessage } from './analysis-packing'
import { sliceProcessingMessage } from './message-processing'

export type MemoryCheckpoint = {
  format: 'memory-adaptive-v1'; layout: string; sourceBudget: number; sourceCount: number
  outputBudget?: number; nextIndex: number; legacyEnd: number; nodes: Record<string, { index: number; split?: boolean }>
}

export function memoryBudget(model: AiModel, inputBudget: number) {
  // 输出规模无法精确预知；先按输出额度限制材料字节数，再由服务端超限反馈缩片。
  return Math.min(inputBudget, resolveModelLimits(model).maxTokens * 4)
}

export function readMemoryCheckpoint(value: string | null): MemoryCheckpoint | undefined {
  if (!value?.startsWith('{')) return
  let state: MemoryCheckpoint
  try { state = JSON.parse(value) } catch { throw new BoundaryError('BATCH_CONFLICT', '断点无法读取，请重新生成。') }
  if (state.format !== 'memory-adaptive-v1' || !/^source-layout-v1:\d+$/.test(state.layout) ||
      !Number.isSafeInteger(state.sourceBudget) || state.sourceBudget < 1 || !Number.isSafeInteger(state.sourceCount) || state.sourceCount < 1 ||
      !Number.isSafeInteger(state.nextIndex) || state.nextIndex < state.sourceCount || !state.nodes || typeof state.nodes !== 'object') {
    throw new BoundaryError('BATCH_CONFLICT', '断点无法读取，请重新生成。')
  }
  return state
}

export function memoryRecovery(state: MemoryCheckpoint, persist: (checkpoint: string) => Promise<void>) {
  const flush = () => persist(JSON.stringify(state))
  return {
    state,
    async node(key: string, originalIndex?: number) {
      if (!state.nodes[key]) {
        state.nodes[key] = { index: originalIndex ?? state.nextIndex++ }
        await flush()
      }
      return state.nodes[key]
    },
    async split(key: string) { state.nodes[key].split = true; await flush() },
  }
}
export type MemoryRecovery = ReturnType<typeof memoryRecovery>
export function isMemoryCapacityError(error: unknown) {
  return ['MODEL_CONTEXT_LIMIT', 'CONTEXT_TOO_LARGE', 'MODEL_OUTPUT_LIMIT'].includes((error as {code?: string})?.code ?? '')
}

export function splitSource(batch: { items: SourceMessage[]; messageIds: string[] }) {
  let parts: SourceMessage[][]
  if (batch.items.length > 1) {
    const sizes = batch.items.map(item => Buffer.byteLength(JSON.stringify(item)))
    const half = sizes.reduce((sum, size) => sum + size, 0) / 2
    let count = 1, size = sizes[0]
    while (count < sizes.length - 1 && size < half) size += sizes[count++]
    parts = [batch.items.slice(0, count), batch.items.slice(count)]
  } else {
    const item = batch.items[0]
    if (!item || item.text.length < 128) return
    let at = Math.floor(item.text.length / 2)
    if (/[\ud800-\udbff]/.test(item.text[at - 1])) at--
    parts = [[sliceProcessingMessage(item, 0, at)], [sliceProcessingMessage(item, at)]]
  }
  const later = new Set(parts[1].flatMap(item => item.sourceIds ?? [item.id]))
  // 一个原消息只有最后一段成功保存后才能计入覆盖进度。
  return parts.map((items, index) => ({ items, messageIds: batch.messageIds.filter(id => index === 1 ? later.has(id) : !later.has(id)) }))
}
