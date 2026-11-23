import { BoundaryError } from '../../src/shared/desktop-validation'

export function isProviderTimeout(error: { code?: unknown; status?: number; name?: string; message?: string }) {
  return error.status === 408 || error.status === 504 || error.name === 'APIConnectionTimeoutError'
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'request_timeout', 'gateway_timeout', 'timeout'].includes(String(error.code))
    || /^(?:(?:HTTP\s+)?(?:408|504)\b|(?:request|connection) timed out\.?$)/i.test(error.message ?? '')
}

export function isPiTimeout(protocol: string, message?: string) {
  if (isProviderTimeout({ message })) return true
  if (protocol !== 'google-generative-ai' || !message?.startsWith('{')) return false
  // Google 的适配器把结构化错误作为消息正文交给 Pi。
  try {
    const cause = JSON.parse(message)?.error
    return cause?.code === 408 || cause?.code === 504 || cause?.status === 'DEADLINE_EXCEEDED'
  } catch { return false }
}

export function modelTimeout() {
  return new BoundaryError('MODEL_TIMEOUT', '模型请求超时，请重试。')
}
