import type { AiApi, AiMethods } from '../shared/ai-contract'
import { BoundaryError, validateError } from '../shared/desktop-validation'
import { validateAiCall, validateAiEvent, validateAiResult } from '../shared/ai-validation'

export function createAiClient(transport: { invoke(method: keyof AiMethods, args: unknown[]): Promise<unknown>; onEvent(listener: (event: unknown) => void): () => void }): AiApi {
  const pendingAnalysisControls = new Map<string, { method: keyof AiMethods; request: Promise<unknown> }>()

  async function invoke(method: keyof AiMethods, args: unknown[]) {
    const response = await transport.invoke(method, args) as { ok: boolean; value?: unknown; error?: unknown }
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw new BoundaryError('INVALID_RESPONSE')
    if (!response.ok) {
      validateError(response.error)
      const { code, action, operationId, failureAtMs } = response.error
      throw new BoundaryError(code, action, operationId, failureAtMs)
    }
    validateAiResult(method, response.value)
    return response.value
  }

  async function call(method: keyof AiMethods, ...args: unknown[]) {
    validateAiCall(method, args)
    if (method !== 'stopAnalysis' && method !== 'continueAnalysis') return invoke(method, args)
    const taskId = args[0] as string
    const pending = pendingAnalysisControls.get(taskId)
    if (pending?.method === method) return pending.request
    const request = invoke(method, args).finally(() => {
      if (pendingAnalysisControls.get(taskId)?.request === request) pendingAnalysisControls.delete(taskId)
    })
    pendingAnalysisControls.set(taskId, { method, request })
    return request
  }
  const names = ['listModels', 'saveModel', 'testModel', 'listSkills', 'previewInsightScope', 'prepareAnalysis', 'discardAnalysisPreparation', 'confirmAnalysis', 'getAnalysis', 'listAnalyses', 'arrangeAnalysis', 'renameAnalysis', 'deleteAnalysis', 'stopAnalysis', 'continueAnalysis', 'getReport', 'readInsightCitation', 'openThread', 'listThreads', 'createThread', 'getThread', 'arrangeThread', 'deleteThread', 'sendTurn', 'retryTurn', 'stopTurn'] as const
  const methods = Object.fromEntries(names.map(name => [name, (...args: unknown[]) => call(name, ...args)])) as AiMethods
  return Object.freeze({ ...methods, onEvent(listener) { let active = true; const off = transport.onEvent(event => { if (!active) return; try { validateAiEvent(event) } catch { return }; listener(event) }); return () => { active = false; off() } } })
}
