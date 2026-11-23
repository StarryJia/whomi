import type { ImportIssue } from './conversation-model'
import type { ImportCounts, ImportFailurePhase } from './import-contract'

export type ImportDiagnostic = { phase: ImportFailurePhase; code: string; jobId?: string }
export type StoredImportDiagnostic = { diagnostic: ImportDiagnostic; counts?: ImportCounts; jobCreatedAt: number }
export type ImportDiagnosticReceipt = { jobId: string; jobCreatedAt: number; signature: string }
export type PersistedImportFailure = StoredImportDiagnostic & { endedAt: number; receipt: ImportDiagnosticReceipt; reported: boolean }

export function currentImportIssue(phase: ImportFailurePhase, issues: readonly ImportIssue[]) {
  if (phase === 'parse') {
    const record = issues.find(issue => issue.severity === 'blocking' && issue.ordinal !== undefined)
    if (record) return record
  }
  return issues.find(issue => issue.severity === 'blocking')
}

export type ImportDiagnosticsApi = {
  report(value: ImportDiagnostic): Promise<void>
  open(jobId?: string | null, operationId?: string): Promise<void>
}

export const importDiagnosticsChannel = 'whomi:import-diagnostics'
export const appExceptionChannel = 'whomi:app-exception'
