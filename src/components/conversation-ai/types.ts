import type { ReferenceRange } from './selection'
import type { AnalysisPreparation, AnalysisTask, AiState, AiUsage, AiThread, AiThreadSummary, AiModelIdentity } from '../../shared/ai-contract'
import type { ModelOption } from './model-selector'

export type GenerationUsage = AiUsage
export type AnalysisProgress = {
  analyzedMessages: number
  totalMessages: number
  outputTokensPerSecond?: number
  usage?: GenerationUsage
  task?: AnalysisTask
}
export type AnalysisResult = { taskId?: string; usage?: GenerationUsage; task?: AnalysisTask }
export type ConversationRequest = {
  requestId?: string
  turnId?: string
  threadId?: string
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
  modelIdentity?: AiModelIdentity
}
export type ConversationAiAdapter = {
  selectedModels?: Partial<Record<'analysis' | 'conversation', string>>
  selectModel?: (feature: 'analysis' | 'conversation', id: string | null) => Promise<void>
  models: readonly ModelOption[]
  skills: readonly { id: string; label: string }[]
  prepareAnalysis?: (request: { conversationId: string; modelId: string }) => Promise<AnalysisPreparation>
  arrangeThread?: import('../../shared/ai-contract').AiMethods['arrangeThread']
  deleteThread?: import('../../shared/ai-contract').AiMethods['deleteThread']
  listThreads?: (conversationId: string) => Promise<AiThreadSummary[]>
  createThread?: (conversationId: string) => Promise<AiThread>
  restoreThread?: (conversationId: string, threadId?: string) => Promise<RestoredConversationTurn[]>
  watchThread?: (conversationId: string, onChange: (turns: RestoredConversationTurn[]) => void, signal: AbortSignal, threadId?: string) => Promise<void>
  watchAnalysis?: (conversationId: string, onChange: (task: AnalysisTask) => void, signal: AbortSignal, taskId?:string) => Promise<void>
  stopTurn?: (turnId: string) => Promise<void>
  stopAnalysis?: (taskId: string) => Promise<AnalysisTask | void>
  continueAnalysis?: (taskId: string, signal: AbortSignal, onProgress: (progress: AnalysisProgress) => void) => Promise<AnalysisResult>
  respond(request: ConversationRequest, options: {
    signal: AbortSignal
    onText: (text: string) => void
  }): Promise<{ text: string; usage?: GenerationUsage; modelIdentity?: AiModelIdentity }>
  analyze(request: { conversationId: string; modelId: string; preparationToken?: string; requestId?: string }, options: {
    signal: AbortSignal
    onProgress: (progress: AnalysisProgress) => void
  }): Promise<AnalysisResult | void>
}
