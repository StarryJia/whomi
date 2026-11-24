import { PiRuntime } from './runtime'
import type { AgentRequest, AgentResponse, InsightHostCall, InsightRequestContext } from './protocol'
import type { InsightReadResult } from '../../src/shared/insight-reader'
import type { AiUsage } from '../../src/shared/ai-contract'

const runtime = new PiRuntime(process.argv[2])
const parent = (process as unknown as { parentPort: { on(event: string, listener: (event: { data: AgentRequest }) => void): void; postMessage(message: AgentResponse): void } }).parentPort
const active = new Map<number, AbortController>()
type HostResult = InsightReadResult | InsightRequestContext
const pendingCalls = new Map<number, { id: number; resolve(result?: HostResult): void; reject(error: Error): void }>()
let nextCall = 0
function callHost(id: number, call: InsightHostCall) {
  const callId = ++nextCall
  return new Promise<HostResult | undefined>((resolve, reject) => {
    pendingCalls.set(callId, { id, resolve, reject })
    parent.postMessage({ event: 'insight', id, callId, call })
  })
}
const cancelAll = () => { for (const controller of active.values()) controller.abort() }
parent.on('message', ({ data }) => {
  if (data.method === 'insightReply') {
    const pending = pendingCalls.get(data.callId)
    if (pending?.id !== data.id) return
    pendingCalls.delete(data.callId)
    if (data.error) pending.reject(Object.assign(new Error(data.error.action), data.error))
    else pending.resolve(data.result)
    return
  }
  if (data.method === 'cancel') { active.get(data.id)?.abort(); return }
  if (data.method === 'close') { cancelAll(); return }
  if (data.method !== 'run') return
  if (active.has(data.id)) return
  const controller = new AbortController()
  active.set(data.id, controller)
  void runtime.run(data.payload, { signal: controller.signal, onText: text => {
    if (!controller.signal.aborted) parent.postMessage({ event: 'text', id: data.id, text })
  }, insight: data.payload.insightSession ? {
    read: async (request, availableTokens, originatingRequestId) => {
      const result = await callHost(data.id, { type: 'read', request, availableTokens, originatingRequestId })
      if (!result || !('page' in result)) throw new Error('未收到聊天记录。')
      return result
    },
    record: async event => {
      const result = await callHost(data.id, { type: 'record', event })
      if (result && !('page' in result)) return result
    },
  } : undefined }).then(result => {
    if (controller.signal.aborted) parent.postMessage({ id: data.id, error: { code: 'AI_STOPPED', action: '回答已停止。' } })
    else parent.postMessage({ id: data.id, result })
  }).catch((error: unknown) => {
    const failure = error as { code?: string; action?: string; name?: string; usage?: AiUsage; retryable?: boolean }
    parent.postMessage({ id: data.id, error: failure.name === 'AbortError'
      ? { code: 'AI_STOPPED', action: '回答已停止。', usage: failure.usage }
      : { code: failure.code ?? 'MODEL_REQUEST_FAILED', action: failure.action ?? '请检查模型服务后重试。', usage: failure.usage,
        ...(failure.retryable === false && { retryable: false }) } })
  }).finally(() => active.delete(data.id))
})
process.on('exit', cancelAll)
