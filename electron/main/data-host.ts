import { utilityProcess } from 'electron'
import { join } from 'node:path'

export interface DataHost {
  request<T>(method: string, payload: unknown): Promise<T>
  close(): Promise<void>
}

export function startDataHost(userDataPath: string): DataHost {
  const probeEnabled = process.argv.includes('--whomi-runtime-test') && process.env.WHOMI_RUNTIME_TEST === userDataPath
  const child = utilityProcess.fork(join(__dirname, 'data/entry.cjs'), [userDataPath, ...(probeEnabled ? ['--runtime-probe'] : [])], { serviceName: 'Whomi Data' })
  let sequence = 0
  let closed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const exited = new Promise<void>((resolve) => child.once('exit', () => {
    closed = true
    for (const request of pending.values()) request.reject(new Error('数据服务已关闭，请重新打开应用。'))
    pending.clear()
    resolve()
  }))
  child.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.result)
  })
  return {
    request<T>(method: string, payload: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error('数据服务已关闭，请重新打开应用。'))
      return new Promise<T>((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        try { child.postMessage({ id, method, payload }) } catch {
          pending.delete(id)
          reject(new Error('无法连接数据服务，请重新打开应用。'))
        }
      })
    },
    async close() {
      if (!closed) { closed = true; child.kill() }
      await exited
    },
  }
}
