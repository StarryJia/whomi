import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { RuntimeInput, RuntimeResult, RuntimeRunner } from './ai-service'

export type AgentHost = RuntimeRunner & { close(): Promise<void> }
export function startAgentHost(directory: string): AgentHost {
  const child = utilityProcess.fork(join(__dirname, 'agent/entry.cjs'), [directory], { serviceName: 'Whomi Agent' })
  let sequence = 0, closed = false
  const pending = new Map<number, { resolve(value: RuntimeResult): void; reject(error: Error): void; onText(text: string): void; release(): void }>()
  const exited = new Promise<void>(resolve => child.once('exit', () => { closed = true; for (const value of pending.values()) { value.release(); value.reject(new BoundaryError('AGENT_UNAVAILABLE', '智能助手已停止，请重新打开应用。')) }; pending.clear(); resolve() }))
  child.on('message', (message: { id: number; event?: string; text?: string; result?: RuntimeResult; error?: { code: string; action: string; usage?: RuntimeResult['usage'] } }) => {
    const current = pending.get(message?.id)
    if (!current) return
    if (message.event === 'text') { if (typeof message.text === 'string') current.onText(message.text); return }
    pending.delete(message.id); current.release()
    if (message.error) { const error = new BoundaryError(message.error.code, message.error.action); Object.assign(error, { usage: message.error.usage }); current.reject(error) }
    else if (message.result) current.resolve(message.result)
    else current.reject(new BoundaryError('INVALID_RESPONSE'))
  })
  return {
    run(input: RuntimeInput, options) {
      if (closed) return Promise.reject(new BoundaryError('AGENT_UNAVAILABLE'))
      if (options.signal.aborted) return Promise.reject(new DOMException('已停止', 'AbortError'))
      return new Promise<RuntimeResult>((resolve, reject) => {
        const id = ++sequence
        let cancelTimer: ReturnType<typeof setTimeout> | undefined
        const cancel = () => {
          child.postMessage({ id, method: 'cancel' })
          cancelTimer = setTimeout(() => { pending.delete(id); options.signal.removeEventListener('abort', cancel); reject(new DOMException('已停止', 'AbortError')) }, 10000)
          cancelTimer.unref()
        }
        pending.set(id, { resolve, reject, onText: text => { if (!options.signal.aborted) options.onText(text) }, release: () => { if (cancelTimer) clearTimeout(cancelTimer); options.signal.removeEventListener('abort', cancel) } })
        options.signal.addEventListener('abort', cancel, { once: true })
        try { child.postMessage({ id, method: 'run', payload: input }) } catch { pending.delete(id); options.signal.removeEventListener('abort', cancel); reject(new BoundaryError('AGENT_UNAVAILABLE')) }
      })
    },
    async close() { if (!closed) { closed = true; child.kill() }; await exited },
  }
}
