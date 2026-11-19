import type { ImportFailurePhase } from '../../../src/shared/import-contract'

export const importLimits = Object.freeze({ maxDepth: 16, maxEntries: 10000, streamFileBytes: 2 * 1024 ** 3,
  boundedFileBytes: 32 * 1024 ** 2, recordBytes: 8 * 1024 ** 2, batchRecords: 500,
  batchBytes: 8 * 1024 ** 2, previewPage: 50, probeBytes: 65536, diskReserveBytes: 256 * 1024 ** 2 })
export class ImportFailure extends Error {
  constructor(readonly code: string, readonly phase?: ImportFailurePhase) { super(code) }
}
export function checkSignal(signal: AbortSignal) { if (signal.aborted) throw new ImportFailure('CANCELLED') }
export function fileLimit(mode: 'stream' | 'bounded') { return mode === 'stream' ? importLimits.streamFileBytes : importLimits.boundedFileBytes }
export function issue(code: string, candidateId = '', severity: 'blocking' | 'warning' = 'blocking') {
  const action = Object.hasOwn(actions, code) ? actions[code] : '请检查导出文件后重试。'
  return { code, candidateId, severity, action }
}
const actions: Readonly<Record<string,string>> = Object.freeze({
  CANCELLED: '导入已取消。',
  DISK_SPACE: '请释放磁盘空间后重试。',
  AMBIGUOUS_MESSAGE: '请改用包含可靠消息标识的导出格式。',
  IMPORT_BUSY: '请完成或取消当前导入。',
  TARGET_REQUIRED: '请检查要导入的会话。',
  TARGET_CONFLICT: '请检查要导入的会话。',
  SELF_CONFLICT: '请为同一会话选择一致的本人账号。',
  NO_IMPORTABLE_CONVERSATIONS: '没有可导入的会话。',
  DISCOVERY_FAILED: '无法查找聊天记录。',
  SOURCE_UNREADABLE: '请确认导出文件仍可读取。',
  SOURCE_CHANGED: '请重新选择已更改的导出文件。',
  STAGING_FAILED: '读取聊天记录失败。',
  COMMIT_FAILED: '保存聊天记录失败。',
  SAVE_CONFIRMATION_MISSING: '无法确认本批保存结果。',
  STATISTICS_FAILED: '会话统计更新失败。',
  CANCEL_FAILED: '取消导入失败，请再次取消。',
  ROLLBACK_STORAGE_ERROR: '请重新打开应用后取消导入。',
  STORAGE_UNWRITABLE: '请检查资料库所在磁盘的剩余空间和访问权限。',
  INTERRUPTED: '导入已中断。',
})
export function failureCode(error: unknown) {
  if (error instanceof ImportFailure) return error.code
  return (error as NodeJS.ErrnoException)?.code === 'ENOSPC' || String((error as NodeJS.ErrnoException)?.code).startsWith('SQLITE_FULL') ? 'DISK_SPACE' : 'SOURCE_UNREADABLE'
}
