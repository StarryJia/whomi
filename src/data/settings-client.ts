import { BoundaryError, validateError } from '../shared/desktop-validation'
import type { SettingsApi } from '../shared/settings-contract'

export const settingsMethods = { get: 0, saveProvider: 1, removeProvider: 1, saveModel: 1, removeModel: 1, syncModels: 1, testModel: 1, stopModelTasks: 1, saveProcessing: 1, selectModel: 2, setDebug: 1, getDiagnostics: 0, getStorage: 0, chooseStorage: 0, relocateStorage: 1, restart: 0 } as const satisfies Record<keyof SettingsApi, number>
export function createSettingsClient(invoke: (method: keyof SettingsApi, args: unknown[]) => Promise<unknown>): SettingsApi {
  return Object.freeze(Object.fromEntries(Object.entries(settingsMethods).map(([method, arity]) => [method, async (...args: unknown[]) => {
    if (args.length !== arity) throw new BoundaryError('INVALID_ARGUMENT')
    const result = await invoke(method as keyof SettingsApi, args)
    if (!result || typeof result !== 'object' || !('ok' in result)) throw new BoundaryError('INVALID_RESPONSE')
    if (result.ok === false && 'error' in result) { validateError(result.error); throw new BoundaryError(result.error.code, result.error.action) }
    if (result.ok !== true || !('value' in result)) throw new BoundaryError('INVALID_RESPONSE')
    return result.value
  }]))) as unknown as SettingsApi
}
