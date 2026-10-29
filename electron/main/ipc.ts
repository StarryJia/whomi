import type { SourceHandle } from '../../src/shared/desktop-api'
import type { ImportSnapshot, StartImportRequest } from '../../src/shared/import-contract'
import { BoundaryError, localId, validateArguments, validateResult, validateSnapshot } from '../../src/shared/desktop-validation'
import type { SourceGrants } from './source-grants'

type Caller = { sender: unknown; senderFrame: { url: string } | null }
type TrustedWindow = { webContents: { mainFrame: { url: string } } }
export function isTrustedCaller(event: Caller, window: TrustedWindow, appUrl: string): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === appUrl
}
type RouterOptions = { grants: SourceGrants; request(method: string, payload: unknown): Promise<unknown>; chooseSources?(owner: number, kind: 'files' | 'directory'): Promise<SourceHandle[]> }
export function createDesktopRouter(options: RouterOptions) {
  const owners = new Map<string, number>(), subscribers = new Map<number, Set<(snapshot: ImportSnapshot) => void>>()
  const progress = new Map<number, { last: number; latest?: ImportSnapshot; timer?: ReturnType<typeof setTimeout> }>()
  function ownJob(owner: number, id: string) {
    if (!localId(id)) throw new BoundaryError('INVALID_RESPONSE')
    owners.set(id, owner)
  }
  function requireJob(owner: number, id: string, recovery = false) {
    if (owners.get(id) !== owner && !(recovery && !owners.has(id))) throw new BoundaryError('INVALID_JOB', '请重新选择导入来源。')
  }
  function publish(value: unknown) {
    try { validateSnapshot(value) } catch { return }
    const owner = owners.get(value.jobId)
    if (owner === undefined || !subscribers.get(owner)?.size) return
    const state = progress.get(owner) ?? { last: -Infinity }; progress.set(owner, state)
    state.latest = value
    function deliver() {
      if (state.timer) clearTimeout(state.timer); state.timer = undefined
      const snapshot = state.latest; state.latest = undefined; state.last = Date.now()
      if (snapshot) for (const listener of subscribers.get(owner!) ?? []) { try { listener(snapshot) } catch { /* A closed window cannot affect import state. */ } }
    }
    const terminal = ['completed', 'partially_completed', 'failed', 'cancelled'].includes(value.status)
    if (terminal || Date.now() - state.last >= 200) deliver()
    else if (!state.timer) { state.timer = setTimeout(deliver, 200 - (Date.now() - state.last)); state.timer.unref() }
  }
  return {
    ownJob,
    async invoke(owner: number, method: unknown, input: unknown) {
      validateArguments(method, input)
      const args = input as unknown[]
      let value: unknown
      if (method === 'chooseSources') value = await options.chooseSources?.(owner, args[0] as 'files' | 'directory')
      else if (method === 'prepareImport') {
        const grants = options.grants.consume(owner, args[0])
        value = await options.request(method, [grants]); validateResult(method, value); ownJob(owner, value as string)
        const snapshot = await options.request('getImport', [value]); validateSnapshot(snapshot)
        publish(snapshot)
      } else {
        if (method === 'getImport' || method === 'cancelImport' || method === 'previewImport') requireJob(owner, args[0] as string, method === 'getImport' || method === 'previewImport')
        if (method === 'startImport') {
          const request = args[0] as StartImportRequest
          requireJob(owner, request.kind === 'stage' ? request.jobId : request.plan.jobId)
        }
        value = await options.request(method, args)
      }
      validateResult(method, value)
      return value
    },
    onImport(owner: number, listener: (snapshot: ImportSnapshot) => void) {
      const listeners = subscribers.get(owner) ?? new Set(); subscribers.set(owner, listeners); listeners.add(listener)
      return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(owner) }
    },
    publish,
    releaseWindow(owner: number) { options.grants.revokeWindow(owner); subscribers.delete(owner); const timer = progress.get(owner)?.timer; if (timer) clearTimeout(timer); progress.delete(owner) },
  }
}
export const desktopChannels = { call: 'whomi:call', drop: 'whomi:drop', progress: 'whomi:import' } as const
export function serializableError(error: unknown) {
  if (error instanceof BoundaryError) return { code: error.code, action: error.action }
  return { code: 'OPERATION_FAILED', action: '操作失败，请重试。' }
}
