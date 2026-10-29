import { describe, expect, it, vi } from 'vitest'
import { createDesktopRouter, isTrustedCaller } from '../../electron/main/ipc'
import { createSourceGrants } from '../../electron/main/source-grants'
import { validateArguments, validateResult, validateSnapshot } from '../../src/shared/desktop-validation'
import { createDesktopClient } from '../../src/data/desktop-client'

const snapshot = { jobId: '1', status: 'awaiting_commit', discovery: null, candidates: [], results: [], issues: [], counts: { seen: 0, validRecords: 0, invalidRecords: 0 }, inserted: 0, duplicates: 0 }
describe('desktop boundary', () => {
  it('checks sender identity, main frame identity and the exact app URL', () => {
    const frame = { url: 'file:///C:/app/index.html' }, contents = { id: 1, mainFrame: frame }
    const window = { webContents: contents }
    expect(isTrustedCaller({ sender: contents, senderFrame: frame }, window, frame.url)).toBe(true)
    expect(isTrustedCaller({ sender: { ...contents }, senderFrame: frame }, window, frame.url)).toBe(false)
    expect(isTrustedCaller({ sender: contents, senderFrame: { ...frame } }, window, frame.url)).toBe(false)
    frame.url = 'file:///C:/app/other.html'
    expect(isTrustedCaller({ sender: contents, senderFrame: frame }, window, 'file:///C:/app/index.html')).toBe(false)
  })
  it('rejects unknown methods and malformed arguments before contacting the worker', async () => {
    const requests: unknown[] = []
    const router = createDesktopRouter({ grants: createSourceGrants(), request: async (...input) => { requests.push(input); return undefined } })
    for (const [method, args] of [['sql', ['select 1']], ['prepareImport', [[{ token: 'fake', displayName: 'x', kind: 'file', rootPath: 'C:/secret' }]]], ['getImport', ['01']], ['readMessages', [{ conversationId: '1', direction: 'after', cursor: '!'.repeat(2049) }]], ['confirmSelf', ['1', 1]], ['retrySummary', ['9223372036854775808']]]) {
      await expect(router.invoke(1, method, args)).rejects.toHaveProperty('code')
    }
    expect(requests).toHaveLength(0)
  })
  it('binds active jobs to the issuing window and permits read only recovery after restart', async () => {
    const router = createDesktopRouter({ grants: createSourceGrants(), request: async (method) => method === 'getImport' ? snapshot : '1' })
    router.ownJob(1, '1')
    await expect(router.invoke(2, 'getImport', ['1'])).rejects.toMatchObject({ code: 'INVALID_JOB' })
    await expect(router.invoke(1, 'getImport', ['1'])).resolves.toMatchObject({ jobId: '1' })
    await expect(router.invoke(1, 'startImport', [{ kind: 'stage', jobId: '2', entryIds: ['entry'] }])).rejects.toMatchObject({ code: 'INVALID_JOB' })
    const restarted = createDesktopRouter({ grants: createSourceGrants(), request: async () => snapshot })
    await expect(restarted.invoke(7, 'getImport', ['1'])).resolves.toMatchObject({ jobId: '1' })
    await expect(restarted.invoke(7, 'cancelImport', ['1'])).rejects.toMatchObject({ code: 'INVALID_JOB' })
  })
  it('checks return values and events and stops delivering after unsubscribe', async () => {
    const router = createDesktopRouter({ grants: createSourceGrants(), request: async () => ({ ...snapshot, jobId: 1 }) })
    router.ownJob(1, '1'); const events: unknown[] = []
    const off = router.onImport(1, value => events.push(value))
    router.publish(snapshot); off(); router.publish(snapshot)
    expect(events).toHaveLength(1)
    router.publish({ ...snapshot, path: 'C:/secret' }); expect(events).toHaveLength(1)
    await expect(router.invoke(1, 'getImport', ['1'])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('preserves self opt out and large decimal IDs while rejecting capabilities in public results', () => {
    const plan = { kind: 'commit', plan: { jobId: '1', decisions: [{ candidateId: 'candidate', target: { kind: 'existing', conversationId: '9007199254740993' }, confirmedAliases: [], selfMemberKey: null }] } }
    expect(() => validateArguments('startImport', [plan])).not.toThrow()
    expect(plan.plan.decisions[0].selfMemberKey).toBeNull()
    expect(() => validateResult('listMembers', [{ id: '9007199254740993', displayName: '示例成员', selfHint: true, confirmedSelf: false }])).not.toThrow()
    expect(() => validateSnapshot({ ...snapshot, privatePath: 'secret' })).toThrow()
    expect(() => validateResult('previewImport', { messages: [{ attachments: [{ locator: 'secret' }] }], nextOrdinal: null })).toThrow()
  })
  it('turns wire errors into actionable errors and releases transport event listeners', async () => {
    let listener: ((value: unknown) => void) | undefined
    const client = createDesktopClient({ invoke: async () => ({ ok: false, error: { code: 'IMPORT_BUSY', action: '请完成或取消当前导入。' } }), onImport(next) { listener = next; return () => { listener = undefined } } })
    await expect(client.getImport('1')).rejects.toMatchObject({ code: 'IMPORT_BUSY', action: '请完成或取消当前导入。' })
    const events: unknown[] = [], off = client.onImport(value => events.push(value))
    listener?.(snapshot); off(); listener?.(snapshot)
    expect(events).toHaveLength(1); expect(listener).toBeUndefined()
  })
  it('refuses malformed error envelopes and unvalidated event bodies', async () => {
    let listener: ((value: unknown) => void) | undefined
    const client = createDesktopClient({ invoke: async () => ({ ok: false, error: { code: 'IMPORT_BUSY', action: '请完成导入。' }, stack: 'private' }), onImport(next) { listener = next; return () => {} } })
    await expect(client.getImport('1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const events: unknown[] = []; client.onImport(value => events.push(value)); listener?.({ ...snapshot, jobId: 1 }); expect(events).toHaveLength(0)
  })
  it('throttles public progress while delivering the last state and terminal state immediately', async () => {
    vi.useFakeTimers()
    try {
      const router = createDesktopRouter({ grants: createSourceGrants(), request: async () => undefined })
      router.ownJob(1, '1'); const events: string[] = []
      router.onImport(1, value => events.push(value.status))
      router.publish({ ...snapshot, status: 'staging' }); router.publish({ ...snapshot, status: 'validating' }); router.publish(snapshot)
      expect(events).toEqual(['staging'])
      await vi.advanceTimersByTimeAsync(200); expect(events).toEqual(['staging', 'awaiting_commit'])
      router.publish({ ...snapshot, status: 'committing' }); router.publish({ ...snapshot, status: 'completed' })
      expect(events).toEqual(['staging', 'awaiting_commit', 'completed'])
      await vi.advanceTimersByTimeAsync(500); expect(events).toHaveLength(3)
      router.releaseWindow(1)
    } finally { vi.useRealTimers() }
  })
})
