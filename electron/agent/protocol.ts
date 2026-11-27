import type { ThinkingLevel } from '../../src/shared/thinking'
import type { AiModel, AiUsage } from '../../src/shared/ai-contract'
import type { InsightReadRequest, InsightReadResult, InsightReadSpan } from '../../src/shared/insight-reader'
import type { ProcessingSettings } from '../../src/shared/settings-contract'
import type { InsightFailureCode } from './insight-request-failure'

export type InsightRuntimeEvent =
  | { type: 'checkpoint'; checkpoint: string }
  | { type: 'requestStart'; requestId: string; kind: 'inference' | 'compaction' }
  | { type: 'requestBlocked'; kind: 'inference' | 'compaction'; code: string }
  | { type: 'request'; requestId: string; kind: 'inference' | 'compaction'; success: boolean; spans: InsightReadSpan[]; usage: AiUsage; checkpoint: string | null
      stopReason?: 'stop' | 'toolUse' | 'length' | 'error' | 'aborted' | 'unknown'; failureCode?: InsightFailureCode; httpStatus?: number; responseReceived?: boolean }
  | { type: 'summary'; requestId: string; saved: boolean }
export type InsightRequestContext = { fullyReviewed?: number; access?: { token: string; baseUrl: string } }
export function completeReadingInstruction(count: number, kind: 'inference' | 'compaction' = 'inference') {
  const next = kind === 'compaction' ? '请在阅读笔记中记明下一步是成稿。' : '请根据已有材料成稿。'
  return `本次范围的 ${count} 条原文已完整送阅。${next}仅在核查具体依据时按原文编号回查，无须从头顺读。`
}
export type InsightRuntimeCallbacks = {
  read(request: InsightReadRequest, availableTokens: number, originatingRequestId?: string): Promise<InsightReadResult>
  record(event: InsightRuntimeEvent): Promise<void | InsightRequestContext>
}
export type InsightHostCall =
  | { type: 'read'; request: InsightReadRequest; availableTokens: number; originatingRequestId?: string }
  | { type: 'record'; event: InsightRuntimeEvent }

export type AgentRunInput = { thinkingLevel?: ThinkingLevel;
  purpose?: 'insight'
  insightSession?: { processing: ProcessingSettings; headers?: Record<string, string>; fixedPromptLength?: number }
  key: string
  checkpoint?: string | null
  model: AiModel
  outputTokenLimit?: number
  apiKey?: string
  systemPrompt: string
  prompt: string
  history?: { role: 'user' | 'assistant'; text: string }[]
}
export type AgentRunResult = { stopReason?: 'length'; text: string; usage: AiUsage; checkpoint: string }
export type AgentRequest = { id: number; method: 'run'; payload: AgentRunInput } | { id: number; method: 'cancel' | 'close' }
  | { id: number; method: 'insightReply'; callId: number; result?: InsightReadResult | InsightRequestContext; error?: { code: string; action: string } }
export type AgentResponse = { id: number; result: AgentRunResult } | { id: number; error: { code: string; action: string; usage?: AiUsage; retryable?: false } } | { event: 'text'; id: number; text: string }
  | { event: 'insight'; id: number; callId: number; call: InsightHostCall }
