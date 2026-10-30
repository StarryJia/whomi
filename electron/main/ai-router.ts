import type { AiEvent, AiMethods, AiThread, AiTurn, AnalysisPreparation, AnalysisTask } from '../../src/shared/ai-contract'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { validateAiCall, validateAiEvent, validateAiResult } from '../../src/shared/ai-validation'

export function createAiRouter(service: AiMethods) {
  const owners = new Map<string, number>()
  const listeners = new Map<number, Set<(event: AiEvent) => void>>()
  function claim(kind: string, id: string, owner: number) {
    const key = `${kind}:${id}`, existing = owners.get(key)
    if (existing !== undefined && existing !== owner) throw new BoundaryError('INVALID_OWNER', '请在原窗口中操作。')
    owners.set(key, owner)
  }
  function requireOwner(kind: string, id: string, owner: number) {
    if (owners.get(`${kind}:${id}`) !== owner) throw new BoundaryError('INVALID_OWNER', '请重新打开对应会话。')
  }
  return {
    async invoke(owner: number, method: unknown, args: unknown) {
      validateAiCall(method, args)
      const input = args as unknown[]
      if (method === 'confirmAnalysis') requireOwner('token', (input[0] as { token: string }).token, owner)
      if (method === 'sendTurn') requireOwner('thread', (input[0] as { threadId: string }).threadId, owner)
      if (method === 'retryTurn' || method === 'stopTurn') requireOwner('turn', input[0] as string, owner)
      if (method === 'continueAnalysis' || method === 'stopAnalysis') requireOwner('analysis', input[0] as string, owner)
      if (method === 'getAnalysis' || method === 'getReport') claim('analysis', input[0] as string, owner)
      if (method === 'getThread') claim('thread', input[0] as string, owner)
      const invoke = service[method] as (...args: unknown[]) => Promise<unknown>
      const value = await invoke(...input)
      validateAiResult(method, value)
      if (method === 'prepareAnalysis') claim('token', (value as AnalysisPreparation).token, owner)
      if (method === 'confirmAnalysis' || method === 'getAnalysis' || method === 'continueAnalysis' || method === 'stopAnalysis') claim('analysis', (value as AnalysisTask).id, owner)
      if (method === 'listAnalyses') for (const task of value as AnalysisTask[]) claim('analysis', task.id, owner)
      if (method === 'openThread' || method === 'getThread') { const thread = value as AiThread; claim('thread', thread.id, owner); for (const turn of thread.turns) claim('turn', turn.id, owner) }
      if (method === 'sendTurn' || method === 'retryTurn' || method === 'stopTurn') claim('turn', (value as AiTurn).id, owner)
      return value
    },
    publish(event: AiEvent) {
      validateAiEvent(event)
      const owner = owners.get(`${event.kind === 'turn' ? 'turn' : 'analysis'}:${event.snapshot.id}`)
      if (owner !== undefined) for (const listener of listeners.get(owner) ?? []) { try { listener(event) } catch { /* 已关闭窗口不影响后台运行。 */ } }
    },
    subscribe(owner: number, listener: (event: AiEvent) => void) { const group = listeners.get(owner) ?? new Set(); group.add(listener); listeners.set(owner, group); return () => { group.delete(listener) } },
    release(owner: number) { listeners.delete(owner); for (const [key, value] of owners) if (value === owner) owners.delete(key) },
  }
}
