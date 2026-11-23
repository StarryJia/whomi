import type { SettingsApi } from '../../src/shared/settings-contract'
import type { ConversationTrace } from '../../src/shared/operation-diagnostics-api'
import { conversationActions } from '../../src/shared/operation-diagnostics-api'
import { isOperationId } from '../../src/shared/operation-diagnostics'
import type { createOperationDiagnostics } from './operation-diagnostics'
import { serializableError } from './ipc'

type Recorder = Pick<ReturnType<typeof createOperationDiagnostics>, 'begin' | 'event' | 'end'>
const categories: Partial<Record<keyof SettingsApi, string>> = {
  savePrompt: 'prompt', saveProcessing: 'processing', setDebug: 'debug',
  selectModel: 'model', saveModel: 'model', removeModel: 'model', syncModels: 'model',
  saveProvider: 'provider', removeProvider: 'provider', setAccountEnabled: 'account',
  signInAccount: 'account', signOutAccount: 'account',
}

export async function recordSetting<T>(store: Recorder, method: keyof SettingsApi, apply: () => Promise<T>): Promise<T> {
  const category = categories[method]
  if (!category) return apply()
  const id = store.begin('settings', 'settingsChange')
  store.event(id, 'settingsSave', { category })
  try {
    const result = await apply()
    store.end(id, 'success')
    return result
  } catch (error) {
    store.end(id, 'failed', { code: serializableError(error).code })
    throw error
  }
}

export function createConversationRecorder(store: Recorder) {
  const active = new Map<string, string>()
  function receive(value: unknown) {
    if (!value || typeof value !== 'object' || !('id' in value) || !isOperationId(value.id)) return
    const trace = value as ConversationTrace
    if (trace.kind === 'start') {
      if (!conversationActions.includes(trace.action) || active.has(trace.id) || active.size >= 256) return
      active.set(trace.id, store.begin('conversation', trace.action))
      return
    }
    const id = active.get(trace.id)
    if (!id) return
    if (trace.kind === 'step' && ['read', 'write', 'locate', 'refresh', 'display'].includes(trace.stage)) {
      store.event(id, trace.stage, { count: trace.count, hasMore: trace.hasMore, found: trace.found })
    }
    if (trace.kind === 'end' && ['success', 'failed', 'unknown'].includes(trace.outcome)) {
      store.end(id, trace.outcome, { code: trace.code })
      active.delete(trace.id)
    }
  }
  return { receive, close() { for (const id of active.values()) store.end(id, 'interrupted'); active.clear() } }
}
