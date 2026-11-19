import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createDesktopClient } from '../../src/data/desktop-client'
import { BoundaryError, validateError } from '../../src/shared/desktop-validation'
import type { DesktopApi, DesktopMethod } from '../../src/shared/desktop-api'
import { createAiClient } from '../../src/data/ai-client'
import { aiChannels, type AiMethods } from '../../src/shared/ai-contract'
import { createSettingsClient } from '../../src/data/settings-client'
import { settingsChannel, type SettingsApi } from '../../src/shared/settings-contract'
import { appExceptionChannel, importDiagnosticsChannel, type ImportDiagnosticsApi } from '../../src/shared/import-diagnostics'

const credential = process.argv.find(value => value.startsWith('--whomi-drop-key='))?.slice('--whomi-drop-key='.length)
// The credential stays in the isolated preload world; page objects cannot grant paths.
const api = createDesktopClient({
  invoke(method, args) { return ipcRenderer.invoke('whomi:call', { method, args }) },
  async acceptDroppedFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > 10000 || !credential) throw new BoundaryError('INVALID_SOURCE', '请拖入磁盘中的文件或文件夹。')
    const paths = files.map(file => {
      try {
        if (!(file instanceof File)) throw new Error()
        const path = webUtils.getPathForFile(file)
        if (!path) throw new Error()
        return path
      } catch { throw new BoundaryError('INVALID_SOURCE', '请拖入磁盘中的文件或文件夹。') }
    })
    return ipcRenderer.invoke('whomi:drop', { credential, paths })
  },
  onImport(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value)
    ipcRenderer.on('whomi:import', receive)
    return () => { ipcRenderer.removeListener('whomi:import', receive) }
  },
})
const ai = createAiClient({
  invoke(method, args) { return ipcRenderer.invoke(aiChannels.call, { method, args }) },
  onEvent(listener) { const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value); ipcRenderer.on(aiChannels.event, receive); return () => { ipcRenderer.removeListener(aiChannels.event, receive) } },
})
const exposedAi = Object.freeze({ ...Object.fromEntries(Object.entries(ai).filter(([name]) => name !== 'onEvent').map(([name, method]) => [name, (...args: unknown[]) => (method as (...args: unknown[]) => Promise<unknown>)(...args).catch((error: unknown) => Promise.reject(error instanceof BoundaryError ? { code: error.code, action: error.action } : { code: 'OPERATION_FAILED', action: '操作失败，请重试。' }))])), onEvent: ai.onEvent }) as AiMethods & Pick<typeof ai, 'onEvent'>
const settings = createSettingsClient((method, args) => ipcRenderer.invoke(settingsChannel, { method, args }))
const exposedSettings = Object.freeze(Object.fromEntries(Object.entries(settings).map(([name, method]) => [name, (...args: unknown[]) =>
  (method as (...args: unknown[]) => Promise<unknown>)(...args).catch((error: unknown) => Promise.reject(error instanceof BoundaryError ? { code: error.code, action: error.action } : { code: 'OPERATION_FAILED', action: '操作失败，请重试。' }))]))) as unknown as SettingsApi
// Electron strips custom Error fields across contextBridge; reject only the public record.
function expose<K extends DesktopMethod | 'acceptDroppedFiles'>(method: K): DesktopApi[K] {
  return ((...args: unknown[]) => (api[method] as (...input: unknown[]) => Promise<unknown>)(...args).catch((error: unknown) => {
    const failure = error instanceof BoundaryError ? { code: error.code, action: error.action } : { code: 'OPERATION_FAILED', action: '操作失败，请重试。' }
    return Promise.reject(failure)
  })) as DesktopApi[K]
}
async function importDiagnosticsCall(operation: 'report' | 'open', value: unknown) {
  const response: unknown = await ipcRenderer.invoke(importDiagnosticsChannel, operation, value)
  if (response && typeof response === 'object' && 'ok' in response) {
    if (response.ok === true) return
    if (response.ok === false && 'error' in response) {
      validateError(response.error)
      throw response.error
    }
  }
  throw { code: 'INVALID_RESPONSE', action: '请重新打开应用后重试。' }
}
const importDiagnostics: ImportDiagnosticsApi = Object.freeze({
  report: (value: Parameters<ImportDiagnosticsApi['report']>[0]) => importDiagnosticsCall('report', value),
  open: (jobId?: string | null) => importDiagnosticsCall('open', jobId),
})
contextBridge.exposeInMainWorld('whomi', Object.freeze({
  ai: exposedAi,
  settings: exposedSettings,
  importDiagnostics,
  onAppException(listener) {
    const receive = (_event: Electron.IpcRendererEvent, notice: { title: string; detail: string }) => listener(notice)
    ipcRenderer.on(appExceptionChannel, receive)
    ipcRenderer.send(appExceptionChannel)
    return () => { ipcRenderer.removeListener(appExceptionChannel, receive) }
  },
  chooseSources: expose('chooseSources'), acceptDroppedFiles: expose('acceptDroppedFiles'), prepareImport: expose('prepareImport'),
  startImport: expose('startImport'), getImport: expose('getImport'), cancelImport: expose('cancelImport'), previewImport: expose('previewImport'),
  getInterruptedImport: expose('getInterruptedImport'),
  listConversations: expose('listConversations'), readMessages: expose('readMessages'), locateSource: expose('locateSource'),
  listMembers: expose('listMembers'), confirmSelf: expose('confirmSelf'), deleteConversation: expose('deleteConversation'), arrangeConversation: expose('arrangeConversation'), retrySummary: expose('retrySummary'), onImport: api.onImport,
  onConversationDeleted: api.onConversationDeleted,
} satisfies DesktopApi))
