import { vi } from 'vitest'
import type { DesktopApi, ImportPreview } from '../shared/desktop-api'
import type { Candidate, ImportCandidateResult, ImportSnapshot } from '../shared/import-contract'

// 全部名称、账号和消息均为虚构测试数据。
export function candidate(id = 'a'): Candidate {
  return { candidateId: id, entryId: 'entry', title: `会话 ${id}`, formatId: 'chatlab', parserVersion: 'test',
    sourceKey: id, kind: 'direct', identity: { platform: 'test', ownerKey: 'owner_suffix', conversationKey: id, namespace: 'test' },
    members: [
      { sourceKey: 'member-1', displayName: '小林', stableAccountKey: 'owner', selfHint: true },
      { sourceKey: 'member-2', displayName: '小林', stableAccountKey: 'other', selfHint: false },
    ], fingerprint: 'test', counts: { seen: 500, validRecords: 500, invalidRecords: 0 }, status: 'staged', issues: [] }
}
export function snapshot(patch: Partial<ImportSnapshot> = {}): ImportSnapshot {
  return { jobId: 'job', status: 'awaiting_confirmation', discovery: { entries: [{ entryId: 'entry', displayName: '两层目录中的记录.json', formatId: 'chatlab' }], unrecognized: [{ displayName: '图片.jpg' }], issues: [] },
    candidates: [], results: [], issues: [], counts: { seen: 0, validRecords: 0, invalidRecords: 0 }, inserted: 0, duplicates: 0, ...patch }
}
export function saved(id: string, conversationId: string, patch: Partial<ImportCandidateResult> = {}): ImportCandidateResult {
  return { candidateId: id, conversationId, status: 'saved', inserted: 500, duplicates: 0, committedAt: 1, issues: [], summaryFailed: false, ...patch }
}
export function fakeImportApi() {
  let current = snapshot()
  const listeners = new Set<(value: ImportSnapshot) => void>()
  const emit = (next: ImportSnapshot) => { current = next; listeners.forEach(listener => listener(next)) }
  const api: DesktopApi = {
    chooseSources: vi.fn(async () => [{ token: 'token', displayName: '导出目录', kind: 'directory' as const }]),
    acceptDroppedFiles: vi.fn(async () => [{ token: 'drop', displayName: '记录.json', kind: 'file' as const }]),
    prepareImport: vi.fn(async () => { emit(snapshot()); return 'job' }),
    getImport: vi.fn(async () => current),
    startImport: vi.fn(async request => {
      if (request.kind === 'stage') emit(snapshot({ status: 'awaiting_commit', candidates: [candidate()] }))
      else emit(snapshot({ status: 'completed', candidates: [candidate()], results: [saved('a', '7')], inserted: 500 }))
      return 'job'
    }),
    cancelImport: vi.fn(async () => { emit({ ...current, status: 'cancelled' }) }),
    onImport: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    previewImport: vi.fn(async (): Promise<ImportPreview> => ({ messages: [{ ordinal: 1, senderKey: 'member-1', senderKind: 'member', senderName: '小林', sentAtMs: null, timeRaw: null, timePrecision: 'unknown', timezone: null, kind: 'text', text: '虚构预览正文', sourceType: null, reply: null, attachments: [] }], nextOrdinal: null })),
    listConversations: vi.fn(async () => ({ items: [{ id: '9', title: '已有会话', kind: 'direct' as const, messageCount: 1, memberCount: 2, firstSentAtMs: null, lastSentAtMs: null, summaryStatus: 'ready' as const }], nextCursor: null })),
    readMessages: vi.fn(), locateSource: vi.fn(), listMembers: vi.fn(), confirmSelf: vi.fn(), retrySummary: vi.fn(async () => {}),
  }
  return { api, emit, listeners }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
