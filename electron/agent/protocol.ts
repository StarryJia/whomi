import type { ThinkingLevel } from '../../src/shared/thinking'
import type { AiModel, AiUsage } from '../../src/shared/ai-contract'
import type { InsightReadRequest, InsightReadResult, InsightReadSpan } from '../../src/shared/insight-reader'
import type { ProcessingSettings } from '../../src/shared/settings-contract'

export type InsightRuntimeEvent =
  | { type: 'checkpoint'; checkpoint: string }
  | { type: 'requestStart'; requestId: string; kind: 'inference' | 'compaction' }
  | { type: 'request'; requestId: string; kind: 'inference' | 'compaction'; success: boolean; spans: InsightReadSpan[]; usage: AiUsage; checkpoint: string | null }
export type InsightRuntimeCallbacks = {
  read(request: InsightReadRequest, availableTokens: number): Promise<InsightReadResult>
  record(event: InsightRuntimeEvent): Promise<void>
}
export type InsightHostCall =
  | { type: 'read'; request: InsightReadRequest; availableTokens: number }
  | { type: 'record'; event: InsightRuntimeEvent }

export type AgentRunInput = { thinkingLevel?: ThinkingLevel;
  purpose?: 'insight'
  insightSession?: { processing: ProcessingSettings; headers?: Record<string, string> }
  key: string
  checkpoint?: string | null
  model: AiModel
  apiKey?: string
  systemPrompt: string
  prompt: string
  history?: { role: 'user' | 'assistant'; text: string }[]
}
export type AgentRunResult = { stopReason?: 'length'; text: string; usage: AiUsage; checkpoint: string }
export type AgentRequest = { id: number; method: 'run'; payload: AgentRunInput } | { id: number; method: 'cancel' | 'close' }
  | { id: number; method: 'insightReply'; callId: number; result?: InsightReadResult; error?: { code: string; action: string } }
export type AgentResponse = { id: number; result: AgentRunResult } | { id: number; error: { code: string; action: string; usage?: AiUsage } } | { event: 'text'; id: number; text: string }
  | { event: 'insight'; id: number; callId: number; call: InsightHostCall }
