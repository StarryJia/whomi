import type { ImportIssue } from './conversation-model'
import type { ImportCounts, ImportFailurePhase } from './import-contract'

export type ImportDiagnostic = { phase: ImportFailurePhase; code: string; jobId?: string }
export type StoredImportDiagnostic = { diagnostic: ImportDiagnostic; counts?: ImportCounts; jobCreatedAt: number }

export function currentImportIssue(phase: ImportFailurePhase, issues: readonly ImportIssue[]) {
  if (phase === 'parse') {
    const record = issues.find(issue => issue.severity === 'blocking' && issue.ordinal !== undefined)
    if (record) return record
  }
  return issues.find(issue => issue.severity === 'blocking')
}

export type ImportDiagnosticsApi = {
  report(value: ImportDiagnostic): Promise<void>
  open(jobId?: string | null): Promise<void>
}

export const importDiagnosticsChannel = 'whomi:import-diagnostics'
export const appExceptionChannel = 'whomi:app-exception'
