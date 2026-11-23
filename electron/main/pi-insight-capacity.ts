import type { AiModel } from '../../src/shared/ai-contract'
import type { InsightSnapshot } from '../../src/shared/conversation-insights'
import { resolveModelLimits } from '../../src/shared/model-limits'
import { insightModelProtocol, registeredModel } from '../agent/reasoning-capabilities'

type CapacitySource = 'configured' | 'catalog' | 'estimated'
export type InsightCapacity = {
  contextWindow: number
  maxTokens: number
  maxInputTokens: number
  contextSource: CapacitySource
  outputSource: CapacitySource
}
export type InsightProtection = { requests: number; input: number; output: number }

function capacity(model: AiModel, catalog?: { contextWindow: number; maxTokens: number }): InsightCapacity {
  const contextWindow = model.contextWindow ?? catalog?.contextWindow ??
    Math.max(16000, (model.maxTokens ?? 0) * 2, model.maxInputTokens ?? 0)
  // 目录输出是能力上限，较小的手填上下文仍须给原文留出空间。
  const defaultOutput = catalog ? Math.min(catalog.maxTokens, Math.floor(contextWindow / 2))
    : Math.min(8192, Math.floor(contextWindow / 4))
  const availableOutput = contextWindow - (model.maxInputTokens ?? 0)
  const maxTokens = model.maxTokens ?? Math.max(1, availableOutput > 0 ? Math.min(defaultOutput, availableOutput) : defaultOutput)
  return {
    ...resolveModelLimits({ contextWindow, maxTokens, maxInputTokens: model.maxInputTokens }),
    contextSource: model.contextWindow != null ? 'configured' : catalog ? 'catalog' : 'estimated',
    outputSource: model.maxTokens != null ? 'configured' : catalog ? 'catalog' : 'estimated',
  }
}

function protection(snapshot: InsightSnapshot, limits: InsightCapacity): InsightProtection {
  const bytes = (snapshot.sourceTextBytes ?? snapshot.sources.length * 256) + snapshot.sources.length * 210
  const page = Math.max(256, Math.floor((limits.maxInputTokens - 1200) / 4))
  const requests = 20 + Math.max(1, Math.ceil(bytes / page)) * 5
  return { requests, input: requests * limits.maxInputTokens, output: requests * limits.maxTokens }
}

export async function insightWorkload(model: AiModel, snapshot: InsightSnapshot, migratingStartedTask: boolean) {
  const catalog = model.contextWindow == null || model.maxTokens == null
    ? await registeredModel({ ...model, protocol: insightModelProtocol(model) }) : undefined
  const limits = capacity(model, catalog)
  const guard = protection(snapshot, limits)
  if (migratingStartedTask) {
    // 旧任务按小窗口发出的请求仍计费；迁移后不能用新任务较少的预计请求数将它锁死。
    const oldContext = model.contextWindow ?? Math.max(16000, (model.maxTokens ?? 0) * 2, model.maxInputTokens ?? 0)
    const oldOutput = model.maxTokens ?? Math.max(1, Math.min(8192, Math.floor(oldContext / 4)))
    const previous = protection(snapshot, capacity({ ...model, contextWindow: oldContext, maxTokens: oldOutput }))
    guard.requests = Math.max(guard.requests, previous.requests)
    guard.input = Math.max(guard.input, previous.input)
    guard.output = Math.max(guard.output, previous.output)
  }
  return { capacity: limits, protection: guard }
}
