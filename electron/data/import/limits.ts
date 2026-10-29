export const importLimits = Object.freeze({ maxDepth: 16, maxEntries: 10000, streamFileBytes: 2 * 1024 ** 3,
  boundedFileBytes: 32 * 1024 ** 2, recordBytes: 8 * 1024 ** 2, batchRecords: 500,
  batchBytes: 8 * 1024 ** 2, previewPage: 50, probeBytes: 65536, diskReserveBytes: 256 * 1024 ** 2 })
export class ImportFailure extends Error {
  constructor(readonly code: string) { super(code) }
}
export function checkSignal(signal: AbortSignal) { if (signal.aborted) throw new ImportFailure('CANCELLED') }
export function fileLimit(mode: 'stream' | 'bounded') { return mode === 'stream' ? importLimits.streamFileBytes : importLimits.boundedFileBytes }
export function issue(code: string, candidateId = '', severity: 'blocking' | 'warning' = 'blocking') {
  return { code, candidateId, severity, action: code === 'CANCELLED' ? '导入已取消。' : code === 'DISK_SPACE' ? '请释放磁盘空间后重试。' : '请检查导出文件后重试。' }
}
export function failureCode(error: unknown) {
  if (error instanceof ImportFailure) return error.code
  return (error as NodeJS.ErrnoException)?.code === 'ENOSPC' || String((error as NodeJS.ErrnoException)?.code).startsWith('SQLITE_FULL') ? 'DISK_SPACE' : 'SOURCE_UNREADABLE'
}
