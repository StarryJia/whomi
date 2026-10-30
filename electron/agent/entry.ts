import { PiRuntime } from './runtime'
import type { AgentRequest, AgentResponse } from './protocol'
import type { AiUsage } from '../../src/shared/ai-contract'

const runtime = new PiRuntime(process.argv[2])
const parent = (process as unknown as { parentPort: { on(event: string, listener: (event: { data: AgentRequest }) => void): void; postMessage(message: AgentResponse): void } }).parentPort
const active = new Map<number, AbortController>()
const cancelAll = () => { for (const controller of active.values()) controller.abort() }
parent.on('message', ({ data }) => {
  if (data.method === 'cancel') { active.get(data.id)?.abort(); return }
  if (data.method === 'close') { cancelAll(); return }
  if (data.method !== 'run') return
  if (active.has(data.id)) return
  const controller = new AbortController()
  active.set(data.id, controller)
  void runtime.run(data.payload, { signal: controller.signal, onText: text => {
    if (!controller.signal.aborted) parent.postMessage({ event: 'text', id: data.id, text })
  } }).then(result => {
    if (controller.signal.aborted) parent.postMessage({ id: data.id, error: { code: 'AI_STOPPED', action: '回答已停止。' } })
    else parent.postMessage({ id: data.id, result })
  }).catch((error: unknown) => {
    const failure = error as { code?: string; action?: string; name?: string; usage?: AiUsage }
    parent.postMessage({ id: data.id, error: failure.name === 'AbortError'
      ? { code: 'AI_STOPPED', action: '回答已停止。', usage: failure.usage }
      : { code: failure.code ?? 'MODEL_REQUEST_FAILED', action: failure.action ?? '请检查模型服务后重试。', usage: failure.usage } })
  }).finally(() => active.delete(data.id))
})
process.on('exit', cancelAll)
