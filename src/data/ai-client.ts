import type { AiApi, AiMethods } from '../shared/ai-contract'
import { BoundaryError, validateError } from '../shared/desktop-validation'
import { validateAiCall, validateAiEvent, validateAiResult } from '../shared/ai-validation'

export function createAiClient(transport: { invoke(method: keyof AiMethods, args: unknown[]): Promise<unknown>; onEvent(listener: (event: unknown) => void): () => void }): AiApi {
  async function call(method: keyof AiMethods, ...args: unknown[]) {
    validateAiCall(method, args)
    const response = await transport.invoke(method, args) as { ok: boolean; value?: unknown; error?: unknown }
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw new BoundaryError('INVALID_RESPONSE')
    if (!response.ok) { validateError(response.error); throw new BoundaryError(response.error.code, response.error.action) }
    validateAiResult(method, response.value)
    return response.value
  }
  const names = ['listModels', 'saveModel', 'testModel', 'listSkills', 'prepareAnalysis', 'confirmAnalysis', 'getAnalysis', 'listAnalyses', 'stopAnalysis', 'continueAnalysis', 'getReport', 'openThread', 'getThread', 'sendTurn', 'retryTurn', 'stopTurn'] as const
  const methods = Object.fromEntries(names.map(name => [name, (...args: unknown[]) => call(name, ...args)])) as AiMethods
  return Object.freeze({ ...methods, onEvent(listener) { let active = true; const off = transport.onEvent(event => { if (!active) return; try { validateAiEvent(event) } catch { return }; listener(event) }); return () => { active = false; off() } } })
}
