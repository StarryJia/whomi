import type { AgentResponse, InsightRuntimeCallbacks } from '../agent/protocol'
import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { RuntimeInput, RuntimeResult, RuntimeRunner } from './ai-service'

export type AgentHost = RuntimeRunner & { close(): Promise<void> }
export function startAgentHost(directory: string): AgentHost {
  const unavailable = () => new BoundaryError('AGENT_UNAVAILABLE', '智能助手已停止，请重新打开应用。')
  const child = utilityProcess.fork(join(__dirname, 'agent/entry.cjs'), [directory], { serviceName: 'Whomi Agent' })
  let sequence = 0, closed = false
  const pending = new Map<number, { inFlight: Set<Promise<unknown>>; resolve(value: RuntimeResult): void; reject(error: Error): void; onText(text: string): void; insight?: InsightRuntimeCallbacks; release(): void }>()
  const exited = new Promise<void>(resolve => child.once('exit', () => { closed = true; for (const value of pending.values()) { value.release(); value.reject(unavailable()) }; pending.clear(); resolve() }))
  child.on('message', async (message: AgentResponse) => {
    const current = pending.get(message?.id)
    if (!current) {
      if (!closed && 'event' in message && message.event === 'insight') child.postMessage({
        id: message.id, method: 'insightReply', callId: message.callId, error: { code: 'AI_STOPPED', action: '洞察已停止。' },
      })
      return
    }
    if ('event' in message) {
      if (message.event === 'text') { current.onText(message.text); return }
      const { id, callId, call } = message
      try {
        if (!current.insight) throw new BoundaryError('INVALID_ARGUMENT')
        const work = call.type === 'read' ? current.insight.read(call.request, call.availableTokens, call.originatingRequestId) : current.insight.record(call.event)
        current.inFlight.add(work)
        const result = await work.finally(() => current.inFlight.delete(work))
        if (!closed) child.postMessage({ id, callId, method: 'insightReply', result })
      } catch (error) {
        const failure = error instanceof BoundaryError ? error : new BoundaryError('INSIGHT_SAVE_FAILED', '请检查本地存储后继续洞察。')
        if (!closed) child.postMessage({ id, callId, method: 'insightReply', error: { code: failure.code, action: failure.action } })
      }
      return
    }
    pending.delete(message.id); current.release()
    if ('error' in message) { const error = new BoundaryError(message.error.code, message.error.action); Object.assign(error, { usage: message.error.usage, retryable: message.error.retryable }); current.reject(error) }
    else if ('result' in message) current.resolve(message.result)
    else current.reject(new BoundaryError('INVALID_RESPONSE'))
  })
  return {
    run(input: RuntimeInput, options) {
      if (closed) return Promise.reject(unavailable())
      if (options.signal.aborted) return Promise.reject(new DOMException('已停止', 'AbortError'))
      return new Promise<RuntimeResult>((resolve, reject) => {
        const id = ++sequence
        let cancelTimer: ReturnType<typeof setTimeout> | undefined
        const inFlight = new Set<Promise<unknown>>()
        const cancel = () => {
          child.postMessage({ id, method: 'cancel' })
          cancelTimer = setTimeout(async () => {
            pending.delete(id)
            options.signal.removeEventListener('abort', cancel)
            // 已开始的断点写入必须先于同一任务的继续或删除结束。
            await Promise.allSettled(inFlight)
            reject(new DOMException('已停止', 'AbortError'))
          }, 10000)
          cancelTimer.unref()
        }
        pending.set(id, { inFlight, resolve, reject, insight: options.insight, onText: text => { if (!options.signal.aborted) options.onText(text) }, release: () => { if (cancelTimer) clearTimeout(cancelTimer); options.signal.removeEventListener('abort', cancel) } })
        options.signal.addEventListener('abort', cancel, { once: true })
        try { child.postMessage({ id, method: 'run', payload: input }) } catch { pending.delete(id); options.signal.removeEventListener('abort', cancel); reject(unavailable()) }
      })
    },
    async close() { if (!closed) { closed = true; child.kill() }; await exited },
  }
}
