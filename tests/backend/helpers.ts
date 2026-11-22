import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), 'whomi-store-'))
  return { path: join(directory, 'test.db'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}
export function message(overrides: Record<string, unknown> = {}) {
  return { modelVersion: 1, conversationKey: 'chat', ordinal: 0, originalId: null, idNamespace: null,
    senderKey: null, senderKind: 'unknown', senderName: '未知发送者', sentAtMs: null, timeRaw: null,
    timePrecision: 'unknown', timezone: null, kind: 'text', text: '', sourceType: null, reply: null,
    attachments: [], extra: {}, ...overrides }
}
