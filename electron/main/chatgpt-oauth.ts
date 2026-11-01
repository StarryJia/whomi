import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { setTimeout as delay } from 'node:timers/promises'
import { BoundaryError } from '../../src/shared/desktop-validation'

export const planScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const canUsePlan = (scope: unknown) => typeof scope === 'string' && scope.split(/\s+/).includes('chatgpt.tokens.use.direct')
const networkError = () => new BoundaryError('CHATGPT_NETWORK', '无法连接 OpenAI，请检查网络后重试。')
type Metadata = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string }
type Json = Record<string, unknown>

// 仅使用 OpenAI 的公开注册和 Responses 路径，不把令牌转发到用户自定义地址。
export function createOpenAiAuthClient(request: typeof fetch, issuer = 'https://auth.openai.com') {
  let metadata: Metadata | undefined
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined
  async function send(url: string, init: RequestInit, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(30_000)
    try {
      return await request(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
    } catch {
      if (signal?.aborted) throw signal.reason
      throw networkError()
    }
  }
  async function json(response: Response): Promise<Json> {
    try {
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error()
      return value as Json
    } catch { throw networkError() }
  }
  async function discovery(signal?: AbortSignal) {
    if (metadata) return metadata
    const response = await send(issuer + '/.well-known/openid-configuration', {}, signal)
    if (!response.ok) throw networkError()
    const record = await json(response)
    if (record.issuer !== issuer) throw networkError()
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      if (issuer === 'https://auth.x.ai' && field === 'revocation_endpoint' && record[field] === undefined) continue
      const value = record[field]
      if (typeof value !== 'string' || !value.startsWith(issuer + '/') || new URL(value).origin !== issuer) throw networkError()
    }
    metadata = record as Metadata
    return metadata
  }
  async function exchange(params: URLSearchParams, signal?: AbortSignal) {
    const endpoints = await discovery(signal)
    const response = await send(endpoints.token_endpoint, { method:'POST', body:params }, signal)
    const value = await json(response)
    if (!response.ok) {
      if (value.error === 'invalid_grant') throw new BoundaryError('CHATGPT_RECONNECT', 'ChatGPT 登录已失效，请重新登录。')
      throw networkError()
    }
    if (typeof value.access_token !== 'string' || !value.access_token ||
      typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
      typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') throw networkError()
    return {access: value.access_token, expiresAt: Date.now() + value.expires_in * 1000,
      refresh: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
      id: typeof value.id_token === 'string' ? value.id_token : undefined, scope: value.scope}
  }
  async function verifyId(id: string, clientId: string, nonce?: string) {
    const endpoints = await discovery()
    keys ??= createRemoteJWKSet(new URL(endpoints.jwks_uri), {
      [customFetch]: (url, options) => request(url, { ...options, redirect:'error' }),
    })
    try {
      const { payload } = await jwtVerify(id, keys, {
        issuer, audience:clientId, algorithms:['RS256'], requiredClaims: ['sub','exp','iat'], clockTolerance:5,
      })
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce) ||
        (payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw Error()
      return {subject:payload.sub, ...(typeof payload.email === 'string' ? {email:payload.email} : {})}
    } catch { throw new BoundaryError('CHATGPT_IDENTITY', '无法验证 ChatGPT 账户，请重新登录。') }
  }
  async function revoke(clientId: string, refresh: string, signal?: AbortSignal) {
    const endpoints = await discovery(signal)
    if (!endpoints.revocation_endpoint) throw networkError()
    const revokeOnce = () => send(endpoints.revocation_endpoint, {method:'POST',body:new URLSearchParams({
      client_id:clientId,token:refresh,token_type_hint:'refresh_token',
    })}, signal)
    const first = await revokeOnce().catch(() => undefined)
    if (first?.ok) return
    if (first && first.status < 500) throw networkError()
    await delay(300, undefined, {signal})
    if (!(await revokeOnce()).ok) throw networkError()
  }
  return {discovery, exchange, verifyId, revoke, send, json}
}
