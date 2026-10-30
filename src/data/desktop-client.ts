import type { DesktopApi, DesktopMethod } from '../shared/desktop-api'
import { BoundaryError, validateArguments, validateError, validateResult, validateSnapshot } from '../shared/desktop-validation'

export type DesktopTransport = {
  invoke(method: DesktopMethod, args: unknown[]): Promise<unknown>
  acceptDroppedFiles?(files: File[]): Promise<unknown>
  onImport(listener: (snapshot: unknown) => void): () => void
}
export function createDesktopClient(transport: DesktopTransport): DesktopApi {
  async function unwrap(method: DesktopMethod, response: unknown) {
    if (!response || typeof response !== 'object' || !('ok' in response)) throw new BoundaryError('INVALID_RESPONSE')
    if (response.ok === false && 'error' in response) {
      if (Object.keys(response).some(key => key !== 'ok' && key !== 'error')) throw new BoundaryError('INVALID_RESPONSE')
      validateError(response.error)
      throw new BoundaryError(response.error.code, response.error.action)
    }
    if (response.ok !== true || !('value' in response) || Object.keys(response).some(key => key !== 'ok' && key !== 'value')) throw new BoundaryError('INVALID_RESPONSE')
    validateResult(method, response.value)
    return response.value
  }
  async function invoke(method: DesktopMethod, args: unknown[]) {
    validateArguments(method, args)
    return unwrap(method, await transport.invoke(method, args))
  }
  const call = <K extends DesktopMethod>(method: K, args: Parameters<DesktopApi[K]>) => invoke(method, args) as ReturnType<DesktopApi[K]>
  return Object.freeze({
    chooseSources: kind => call('chooseSources', [kind]), prepareImport: handles => call('prepareImport', [handles]),
    startImport: request => call('startImport', [request]), getImport: jobId => call('getImport', [jobId]), cancelImport: jobId => call('cancelImport', [jobId]),
    previewImport: (jobId, candidateId, options) => call('previewImport', [jobId, candidateId, options]),
    listConversations: input => call('listConversations', [input]), readMessages: input => call('readMessages', [input]), locateSource: input => call('locateSource', [input]),
    listMembers: id => call('listMembers', [id]), confirmSelf: (id, member) => call('confirmSelf', [id, member]),
    deleteConversation: id => call('deleteConversation', [id]), retrySummary: id => call('retrySummary', [id]),
    async acceptDroppedFiles(files: File[]) {
      if (!transport.acceptDroppedFiles) throw new BoundaryError('INVALID_SOURCE', '请在桌面应用中选择文件。')
      return await unwrap('chooseSources', await transport.acceptDroppedFiles(files)) as Awaited<ReturnType<DesktopApi['acceptDroppedFiles']>>
    },
    onImport(listener) {
      if (typeof listener !== 'function') throw new BoundaryError('INVALID_ARGUMENT')
      let active = true
      const off = transport.onImport(value => { if (!active) return; try { validateSnapshot(value) } catch { return }; listener(value) })
      return () => { active = false; off() }
    },
  } satisfies DesktopApi)
}
export function getDesktopClient(): DesktopApi {
  if (!window.whomi) throw new BoundaryError('DESKTOP_REQUIRED', '请在桌面应用中打开。')
  return window.whomi
}
