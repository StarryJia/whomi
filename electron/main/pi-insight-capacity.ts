import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSnapshot } from '../../src/shared/conversation-insights'
import type { ThinkingLevel } from '../../src/shared/thinking'
import { resolveAgentModelCapacity } from '../agent/model-capacity'
import { insightModelProtocol } from '../agent/reasoning-capabilities'

export type InsightCapacity = Awaited<ReturnType<typeof resolveAgentModelCapacity>>
export type InsightProtection = { requests: number; input: number; output: number }

function protection(snapshot: InsightSnapshot, limits: Pick<InsightCapacity, 'maxInputTokens' | 'maxTokens'>): InsightProtection {
  const bytes = (snapshot.sourceTextBytes ?? snapshot.sources.length * 256) + snapshot.sources.length * 210
  const page = Math.max(256, Math.floor((limits.maxInputTokens - 1200) / 4))
  const requests = 20 + Math.max(1, Math.ceil(bytes / page)) * 5
  return { requests, input: requests * limits.maxInputTokens, output: requests * limits.maxTokens }
}

export async function insightWorkload(model: AiModel, snapshot: InsightSnapshot, migratingStartedTask: boolean, thinkingLevel?: ThinkingLevel) {
  const limits = await resolveAgentModelCapacity({ ...model, protocol: insightModelProtocol(model) }, thinkingLevel)
  const guard = protection(snapshot, limits)
  if (migratingStartedTask) {
    // 旧任务按小窗口发出的请求仍计费；迁移后不能用新任务较少的预计请求数将它锁死。
    const oldContext = model.contextWindow ?? Math.max(16000, (model.maxTokens ?? 0) * 2, model.maxInputTokens ?? 0)
    const oldOutput = model.maxTokens ?? Math.max(1, Math.min(8192, Math.floor(oldContext / 4)))
    const previous = protection(snapshot, { maxInputTokens: Math.min(model.maxInputTokens ?? oldContext, oldContext - oldOutput), maxTokens: oldOutput })
    guard.requests = Math.max(guard.requests, previous.requests)
    guard.input = Math.max(guard.input, previous.input)
    guard.output = Math.max(guard.output, previous.output)
  }
  return { capacity: limits, protection: guard }
}
