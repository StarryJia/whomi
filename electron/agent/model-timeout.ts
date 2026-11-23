import { BoundaryError } from '../../src/shared/desktop-validation'

export function isProviderTimeout(error: { code?: unknown; status?: number; name?: string; message?: string }) {
  return error.status === 408 || error.status === 504 || error.name === 'APIConnectionTimeoutError'
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'request_timeout', 'gateway_timeout', 'timeout'].includes(String(error.code))
    || /^(?:(?:HTTP\s+)?(?:408|504)\b|(?:request|connection) timed out\.?$)/i.test(error.message ?? '')
}

export function modelTimeout() {
  return new BoundaryError('MODEL_TIMEOUT', '模型请求超时，请重试。')
}
