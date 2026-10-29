import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { BoundaryError, validateError, validateSnapshot } from '../../src/shared/desktop-validation'
import type { ImportSnapshot } from '../../src/shared/import-contract'

export interface DataHost {
  request<T>(method: string, payload: unknown): Promise<T>
  close(): Promise<void>
  onEvent(listener: (snapshot: ImportSnapshot) => void): () => void
}

export function startDataHost(userDataPath: string): DataHost {
  const probeEnabled = process.argv.includes('--whomi-runtime-test') && process.env.WHOMI_RUNTIME_TEST === userDataPath
  const child = utilityProcess.fork(join(__dirname, 'data/entry.cjs'), [userDataPath, ...(probeEnabled ? ['--runtime-probe'] : [])], { serviceName: 'Whomi Data' })
  let sequence = 0
  let closed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const listeners = new Set<(snapshot: ImportSnapshot) => void>()
  const exited = new Promise<void>((resolve) => child.once('exit', () => {
    closed = true
    for (const request of pending.values()) request.reject(new BoundaryError('SERVICE_UNAVAILABLE', '请重新打开应用。'))
    pending.clear()
    listeners.clear()
    resolve()
  }))
  child.on('message', (message: { id: number; result?: unknown; error?: unknown; event?: string; value?: unknown }) => {
    if (message?.event === 'import') {
      try { validateSnapshot(message.value) } catch { return }
      for (const listener of listeners) { try { listener(message.value) } catch { /* A consumer cannot stop the data host. */ } }
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) {
      try { validateError(message.error); request.reject(new BoundaryError(message.error.code, message.error.action)) }
      catch { request.reject(new BoundaryError('INVALID_RESPONSE', '请重新打开应用。')) }
    }
    else request.resolve(message.result)
  })
  return {
    request<T>(method: string, payload: unknown): Promise<T> {
      if (closed) return Promise.reject(new BoundaryError('SERVICE_UNAVAILABLE', '请重新打开应用。'))
      return new Promise<T>((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        try { child.postMessage({ id, method, payload }) } catch {
          pending.delete(id)
          reject(new BoundaryError('SERVICE_UNAVAILABLE', '请重新打开应用。'))
        }
      })
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async close() {
      if (!closed) { closed = true; child.kill() }
      await exited
    },
  }
}
