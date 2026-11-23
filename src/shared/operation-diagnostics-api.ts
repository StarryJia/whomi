export const operationDiagnosticsChannel = 'whomi:operation-diagnostics'
export const conversationActions = ['open', 'page', 'locate', 'delete', 'arrange', 'rename'] as const
export type ConversationAction = typeof conversationActions[number]
export type ConversationStep = 'read' | 'write' | 'locate' | 'refresh' | 'display'
export type ConversationTrace =
  | { id: string; kind: 'start'; action: ConversationAction }
  | { id: string; kind: 'step'; stage: ConversationStep; count?: number; hasMore?: boolean; found?: boolean }
  | { id: string; kind: 'end'; outcome: 'success' | 'failed' | 'unknown'; code?: string }

export type OperationDiagnosticsApi = {
  conversation(event: ConversationTrace): void
  importRefresh(jobId: string, jobCreatedAt: number | undefined, result: 'success' | 'failed' | 'unknown'): Promise<void>
}
