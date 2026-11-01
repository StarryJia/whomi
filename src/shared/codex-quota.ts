export type CodexQuotaAction = 'read' | 'connect' | 'disconnect'
export type CodexQuotaWindow = { seconds: number; remainingPercent: number; resetsAt: number | null }
export type CodexQuotaState =
  | { state: 'disconnected' }
  | { state: 'unavailable'; reason: 'source-changed' | 'login-required' | 'unsupported' }
  | { state: 'ready'; source: { email: string; workspaceId: string; authFile: string }; planType: string | null; windows: CodexQuotaWindow[]; updatedAt: number }
