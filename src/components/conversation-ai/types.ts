import type { ReferenceRange } from './selection'
import type { AnalysisPreparation, AnalysisTask, AiState, AiUsage } from '../../shared/ai-contract'
import type { ModelOption } from './model-selector'

export type GenerationUsage = AiUsage
export type AnalysisProgress = {
  analyzedMessages: number
  totalMessages: number
  outputTokensPerSecond?: number
  usage?: GenerationUsage
}
export type AnalysisResult = { taskId?: string; usage?: GenerationUsage }
export type ConversationRequest = {
  requestId?: string
  turnId?: string
  referenceIds?: readonly string[]
  conversationId: string
  prompt: string
  references: readonly ReferenceRange[]
  modelId: string
  skillId?: string
  history?: readonly { role: 'user' | 'assistant'; text: string; references?: readonly ReferenceRange[] }[]
}
export type RestoredConversationTurn = {
  id: string; requestId: string; prompt: string; referenceIds: string[]; modelId: string; skillId?: string
  text: string; state: AiState; usage?: GenerationUsage; error?: string
}
export type ConversationAiAdapter = {
  selectedModels?: Partial<Record<'analysis' | 'conversation', string>>
  selectModel?: (feature: 'analysis' | 'conversation', id: string | null) => Promise<void>
  models: readonly ModelOption[]
  skills: readonly { id: string; label: string }[]
  prepareAnalysis?: (request: { conversationId: string; modelId: string }) => Promise<AnalysisPreparation>
  restoreThread?: (conversationId: string) => Promise<RestoredConversationTurn[]>
  watchThread?: (conversationId: string, onChange: (turns: RestoredConversationTurn[]) => void, signal: AbortSignal) => Promise<void>
  watchAnalysis?: (conversationId: string, onChange: (task: AnalysisTask) => void, signal: AbortSignal) => Promise<void>
  stopTurn?: (turnId: string) => Promise<void>
  stopAnalysis?: (taskId: string) => Promise<void>
  respond(request: ConversationRequest, options: {
    signal: AbortSignal
    onText: (text: string) => void
  }): Promise<{ text: string; usage?: GenerationUsage }>
  analyze(request: { conversationId: string; modelId: string; preparationToken?: string; requestId?: string }, options: {
    signal: AbortSignal
    onProgress: (progress: AnalysisProgress) => void
  }): Promise<AnalysisResult | void>
}
