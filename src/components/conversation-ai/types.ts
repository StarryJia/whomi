import type { ReferenceRange } from './selection'

export type GenerationUsage = {
  inputTokens?: number
  outputTokens?: number
  outputTokensPerSecond?: number
  firstTokenMs?: number
  durationMs?: number
}
export type AnalysisProgress = {
  analyzedMessages: number
  totalMessages: number
  outputTokensPerSecond?: number
  usage?: GenerationUsage
}
export type AnalysisResult = { taskId?: string; usage?: GenerationUsage }
export type ConversationRequest = {
  conversationId: string
  prompt: string
  references: readonly ReferenceRange[]
  modelId: string
  skillId?: string
  history?: readonly { role: 'user' | 'assistant'; text: string; references?: readonly ReferenceRange[] }[]
}
export type ConversationAiAdapter = {
  models: readonly { id: string; label: string }[]
  skills: readonly { id: string; label: string }[]
  respond(request: ConversationRequest, options: {
    signal: AbortSignal
    onText: (text: string) => void
  }): Promise<{ text: string; usage?: GenerationUsage }>
  analyze(request: { conversationId: string; modelId: string }, options: {
    signal: AbortSignal
    onProgress: (progress: AnalysisProgress) => void
  }): Promise<AnalysisResult | void>
}
