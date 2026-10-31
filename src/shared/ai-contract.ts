import type { ModelProtocol } from './model-protocol'

export type AiUsage = { inputTokens?: number; totalInputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokensPerSecond?: number; firstTokenMs?: number; durationMs?: number; startedAt?: number; completedAt?: number; incomplete?: boolean }
export type AiModel = { id: string; label: string; model: string; baseUrl: string; protocol?: ModelProtocol; contextWindow: number | null; maxTokens: number | null; maxInputTokens?: number | null; version: number; enabled: boolean; hasCredential: boolean }
export type SaveAiModel = Omit<AiModel, 'version' | 'hasCredential'> & { apiKey?: string }
export type AiSkill = { id: string; label: string; version: string }
export type AiState = 'queued' | 'running' | 'summarizing' | 'completed' | 'stopped' | 'failed' | 'interrupted'
export type AiObservation = { text: string; evidenceMessageIds: string[]; limitations: string }
export type AiReport = { summary: string; observations: AiObservation[]; limitations: string }
export type AnalysisPreparation = { token: string; conversationId: string; title: string; selfName: string; totalMessages: number; analyzableMessages: number; snapshotMaxId: string; expiresAt: number; model: AiModel }
export type AnalysisTask = { id: string; conversationId: string; modelId: string; state: AiState; analyzedMessages: number; totalMessages: number; skippedMessages: number; usage: AiUsage; error?: string; report?: AiReport; valid: boolean; eventSequence: number }
export type AiTurn = { id: string; threadId: string; requestId: string; prompt: string; referenceIds: string[]; modelId: string; skillId?: string; text: string; state: AiState; attempt: number; usage: AiUsage; error?: string; eventSequence: number }
export type AiThreadSummary = { id: string; conversationId: string; title: string; createdAtMs: number; updatedAtMs: number }
export type AiThread = AiThreadSummary & { turns: AiTurn[] }
export type AiEvent = { kind: 'analysis'; snapshot: AnalysisTask } | { kind: 'turn'; snapshot: AiTurn }
export type AiMethods = {
  listModels(): Promise<AiModel[]>
  saveModel(input: SaveAiModel): Promise<AiModel>
  testModel(modelId: string): Promise<void>
  listSkills(): Promise<AiSkill[]>
  prepareAnalysis(input: { conversationId: string; modelId: string }): Promise<AnalysisPreparation>
  confirmAnalysis(input: { token: string; requestId: string }): Promise<AnalysisTask>
  getAnalysis(taskId: string): Promise<AnalysisTask>
  listAnalyses(conversationId?: string): Promise<AnalysisTask[]>
  stopAnalysis(taskId: string): Promise<AnalysisTask>
  continueAnalysis(taskId: string): Promise<AnalysisTask>
  getReport(taskId: string): Promise<AiReport>
  openThread(conversationId: string): Promise<AiThread>
  listThreads(conversationId: string): Promise<AiThreadSummary[]>
  createThread(conversationId: string): Promise<AiThread>
  getThread(threadId: string): Promise<AiThread>
  sendTurn(input: { threadId: string; requestId: string; prompt: string; referenceIds: string[]; modelId: string; skillId?: string }): Promise<AiTurn>
  retryTurn(turnId: string): Promise<AiTurn>
  stopTurn(turnId: string): Promise<AiTurn>
}
export type AiApi = AiMethods & { onEvent(listener: (event: AiEvent) => void): () => void }
export const aiChannels = { call: 'whomi:ai-call', event: 'whomi:ai-event' } as const
