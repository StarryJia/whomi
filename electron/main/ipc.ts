import type { SourceHandle } from '../../src/shared/desktop-api'
import type { ImportSnapshot, StartImportRequest } from '../../src/shared/import-contract'
import { terminalImportStates } from '../../src/shared/import-contract'
import { BoundaryError, localId, serializableError, validateArguments, validateResult, validateSnapshot } from '../../src/shared/desktop-validation'
import type { SourceGrants } from './source-grants'
import type { ImportOperationTracker } from './import-operation-tracker'

type Caller = { sender: unknown; senderFrame: { url: string } | null }
type TrustedWindow = { webContents: { mainFrame: { url: string } } }
function documentUrl(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.href
}
export function isTrustedCaller(event: Caller, window: TrustedWindow, appUrl: string): boolean {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame) return false
  try { return documentUrl(event.senderFrame.url) === documentUrl(appUrl) } catch { return false }
}
type RouterOptions = { grants: SourceGrants; imports?: ImportOperationTracker; request(method: string, payload: unknown): Promise<unknown>; chooseSources?(owner: number, kind: 'files' | 'directory'): Promise<SourceHandle[]> }
export function createDesktopRouter(options: RouterOptions) {
  const owners = new Map<string, number>(), subscribers = new Map<number, Set<(snapshot: ImportSnapshot) => void>>()
  const progress = new Map<number, { last: number; latest?: ImportSnapshot; timer?: ReturnType<typeof setTimeout> }>()
  const recovered = new Set<string>()
  function ownJob(owner: number, id: string) {
    if (!localId(id)) throw new BoundaryError('INVALID_RESPONSE')
    owners.set(id, owner)
  }
  function requireJob(owner: number, id: string, recovery = false) {
    if (owners.get(id) !== owner && !(recovery && !owners.has(id))) throw new BoundaryError('INVALID_JOB', '请重新选择导入来源。')
  }
  function publish(value: unknown) {
    try { validateSnapshot(value) } catch { return }
    options.imports?.observe(value)
    const owner = owners.get(value.jobId)
    if (owner === undefined || !subscribers.get(owner)?.size) return
    const state = progress.get(owner) ?? { last: -Infinity }; progress.set(owner, state)
    state.latest = value
    function deliver() {
      if (state.timer) clearTimeout(state.timer); state.timer = undefined
      const snapshot = state.latest; state.latest = undefined; state.last = Date.now()
      if (snapshot) for (const listener of subscribers.get(owner!) ?? []) { try { listener(snapshot) } catch { /* A closed window cannot affect import state. */ } }
    }
    if (terminalImportStates.has(value.status) || Date.now() - state.last >= 200) deliver()
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
        let operationId: string | undefined
        const grants = options.grants.consume(owner, args[0], source => { operationId = options.imports?.begin(args[0] as SourceHandle[], source) })
        try {
          value = await options.request(method, operationId ? [grants, operationId] : [grants])
          validateResult(method, value)
        } catch (cause) {
          if (operationId) {
            options.imports?.prepareFailed(operationId, cause)
            const failure = serializableError(cause)
            throw new BoundaryError(failure.code, failure.action, operationId)
          }
          throw cause
        }
        ownJob(owner, value as string)
        try { publish(await options.request('getImport', [value])) }
        catch { /* 已受理的导入仍需返回任务编号，以便查询或取消。 */ }
      } else {
        if (method === 'getImport' || method === 'cancelImport' || method === 'previewImport') {
          const id = args[0] as string
          requireJob(owner, id, true)
          if (method === 'cancelImport' && !owners.has(id)) {
            const snapshot = await options.request('getImport', [id]); validateSnapshot(snapshot)
            if (!['failed', 'cancelled', 'partially_completed'].includes(snapshot.status)) throw new BoundaryError('INVALID_JOB', '请重新选择导入来源。')
            await options.imports?.recover(snapshot)
          }
        }
        if (method === 'startImport') {
          const request = args[0] as StartImportRequest
          requireJob(owner, request.kind === 'stage' ? request.jobId : request.plan.jobId)
          options.imports?.requested(request)
        }
        if (method === 'cancelImport') options.imports?.requested(args[0] as string)
        try { value = await options.request(method, args) }
        catch (cause) {
          if (method === 'cancelImport' || method === 'startImport') options.imports?.requestFailed(args[0] as StartImportRequest | string, cause)
          throw cause
        }
      }
      validateResult(method, value)
      if (method === 'getImport' && options.imports) {
        const snapshot = value as ImportSnapshot
        if (snapshot.operationId && !owners.has(snapshot.jobId) && !recovered.has(snapshot.operationId)) {
          recovered.add(snapshot.operationId)
          await options.imports.recover(snapshot).catch(() => {})
        } else options.imports.observe(snapshot)
      }
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
export { serializableError }
