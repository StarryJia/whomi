import type { AiModel, AiUsage } from '../../src/shared/ai-contract'

export type AgentRunInput = {
  key: string
  checkpoint?: string | null
  model: AiModel
  apiKey?: string
  systemPrompt: string
  prompt: string
  history?: { role: 'user' | 'assistant'; text: string }[]
}
export type AgentRunResult = { text: string; usage: AiUsage; checkpoint: string }
export type AgentRequest = { id: number; method: 'run'; payload: AgentRunInput } | { id: number; method: 'cancel' | 'close' }
export type AgentResponse = { id: number; result: AgentRunResult } | { id: number; error: { code: string; action: string; usage?: AiUsage } } | { event: 'text'; id: number; text: string }
