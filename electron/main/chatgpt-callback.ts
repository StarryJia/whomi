import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BoundaryError } from '../../src/shared/desktop-validation'

type Result = { code: string; clientId: string | null }
export async function openCallback(state: string, signal: AbortSignal, path = '/auth/callback', port = 0) {
  let resolve!: (value: Result) => void
  let reject!: (reason: unknown) => void
  const result = new Promise<Result>((yes, no) => { resolve = yes; reject = no })
  // 系统浏览器尚未返回时也可能已经取消。
  void result.catch(() => {})
  let consumed = false
  const server = createServer((request, response) => {
    function reply(status: number, message: string) {
      response.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', Connection: 'close'})
      response.end(message)
    }
    const host = '127.0.0.1:' + request.socket.localPort
    if (request.method !== 'GET' || request.headers.host !== host) return reply(400, '请返回 Whomi 重新登录。')
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://' + host) } catch { return reply(400, '请返回 Whomi。') }
    if (url.origin !== 'http://' + host || url.pathname !== path) return reply(404, '请返回 Whomi。')
    const params = url.searchParams
    if (consumed || params.getAll('state').length !== 1 || params.get('state') !== state) return reply(400, '此登录链接无效，请返回 Whomi。')
    consumed = true
    if (params.has('error')) {
      reply(200, '登录已取消，请返回 Whomi。')
      reject(new BoundaryError('CHATGPT_DENIED', '授权未完成，请重新使用 ChatGPT 登录。'))
    } else if (params.getAll('code').length === 1 && params.get('code') && params.getAll('client_id').length <= 1) {
      reply(200, '请返回 Whomi 完成连接。')
      resolve({ code: params.get('code')!, clientId: params.get('client_id') })
    } else {
      reply(400, '此登录链接无效，请返回 Whomi。')
      reject(new BoundaryError('CHATGPT_CALLBACK', '登录回调无效，请重新登录。'))
    }
  })
  const cancel = () => reject(signal.reason)
  function close() {
    signal.removeEventListener('abort', cancel)
    server.close()
    server.closeIdleConnections()
  }
  try {
    signal.throwIfAborted()
    await new Promise<void>((ready, fail) => {
      server.once('error', fail)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, ready)
    })
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    return { uri: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + path, result, close }
  } catch (error) {
    close()
    if (signal.aborted) throw signal.reason
    throw new BoundaryError('CHATGPT_CALLBACK', '无法接收浏览器登录结果，请重试。')
  }
}
