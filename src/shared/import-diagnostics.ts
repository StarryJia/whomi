import type { ImportFailurePhase } from './import-contract'

export type ImportDiagnostic = { phase: ImportFailurePhase; code: string; jobId?: string }
export type ImportDiagnosticsApi = {
  report(value: ImportDiagnostic): Promise<void>
  open(jobId?: string | null): Promise<void>
}

export const importDiagnosticsChannel = 'whomi:import-diagnostics'
export const appExceptionChannel = 'whomi:app-exception'
