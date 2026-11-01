import { createHash, randomBytes } from 'node:crypto'
import { chatgptBaseUrl, type ChatgptStatus } from '../../src/shared/chatgpt-plan'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { accountId, createAuthStore, type Account, type AuthVault, type Tokens } from './chatgpt-auth-store'
import { openCallback } from './chatgpt-callback'
import { canUsePlan, createOpenAiAuthClient, planScopes } from './chatgpt-oauth'

type Options = { directory: string; vault: AuthVault; openBrowser: (url: string) => Promise<void>; fetch?: typeof fetch }
const random = () => randomBytes(32).toString('base64url')
const cancelled = () => new BoundaryError('CHATGPT_CANCELLED', '已取消 ChatGPT 登录。')
const signInRequired = () => new BoundaryError('CHATGPT_RECONNECT', '请重新使用 ChatGPT 登录。')
const accountChanged = () => new BoundaryError('CHATGPT_ACCOUNT_CHANGED', 'ChatGPT 账户已变化，请重新选择模型。')
const permissionRequired = () => new BoundaryError('CHATGPT_PERMISSION', '请重新登录并允许 Whomi 使用 ChatGPT 套餐。')
function safeError(error: unknown) {
  return error instanceof BoundaryError ? error : new BoundaryError('CHATGPT_NETWORK', '连接 ChatGPT 失败，请重试。')
}

export function createChatgptAuth(options: Options) {
  const store = createAuthStore(options.directory, options.vault)
  const client = createOpenAiAuthClient(options.fetch ?? fetch)
  const lifetime = new AbortController()
  let attempt: AbortController | undefined
  let session = new AbortController()
  let renewing: Promise<void> | undefined
  let signingOut: Promise<void> | undefined
  function status(): ChatgptStatus {
    if (attempt) return { state:'pending' }
    const {registration,tokens} = store.read()
    if (!signingOut && registration?.subject && registration.needsConsent && !tokens) {
      return {state:'disconnected',planPermissionNeeded:true,accountId:accountId(registration),...(registration.email ? {email:registration.email} : {})}
    }
    if (!registration?.subject || !tokens || signingOut) return { state:'disconnected' }
    return {state:'connected',accountId:accountId(registration),...(registration.email ? {email:registration.email} : {})}
  }
  function requireAccount(expected: string) {
    const record = store.read()
    if (!record.registration?.subject || !record.tokens || signingOut || lifetime.signal.aborted) throw signInRequired()
    if (!expected || accountId(record.registration) !== expected) throw accountChanged()
    return { record, registration:record.registration, tokens:record.tokens }
  }
  function stopSession() {
    session.abort(accountChanged())
    session = new AbortController()
  }
  async function signIn(newAccount = false): Promise<ChatgptStatus> {
    if (attempt || signingOut || lifetime.signal.aborted) throw new BoundaryError('CHATGPT_BUSY', '请先完成或取消当前连接操作。')
    const original = store.read()
    // 更换连接前先退出原会话，让运行中的请求和续期全部结束。
    if (original.tokens) return status()
    const controller = new AbortController()
    attempt = controller
    const deadline = setTimeout(() => controller.abort(new BoundaryError('CHATGPT_TIMEOUT', '登录已超时，请重新登录。')), 5 * 60_000)
    const signal = controller.signal
    let callback: Awaited<ReturnType<typeof openCallback>> | undefined
    try {
      store.save(original)
      const known = newAccount ? undefined : original.registration
      const endpoints = await client.discovery(signal)
      const state = random(), nonce = random(), verifier = random()
      callback = await openCallback(state, signal)
      const url = new URL(endpoints.authorization_endpoint)
      url.search = new URLSearchParams({client_id:known?.clientId ?? 'dynamic_agent_client',ext_agent_host_id:original.hostId,
        response_type:'code',scope:planScopes,resource:chatgptBaseUrl,state,nonce,redirect_uri:callback.uri,
        code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),
        ...(known?.needsConsent ? {prompt:'consent'} : {}),
        ...(known ? (known.email ? { login_hint:known.email } : {}) : {agent_name_hint:'Whomi'})}).toString()
      const [result] = await Promise.all([callback.result, options.openBrowser(url.href)])
      signal.throwIfAborted()
      const clientId = result.clientId ?? known?.clientId
      if (!clientId || !/^[A-Za-z0-9_.:-]{1,256}$/.test(clientId) || clientId === 'dynamic_agent_client' ||
        (known && result.clientId && result.clientId !== known.clientId)) throw accountChanged()
      const registration = known ?? {clientId}
      store.save({hostId:original.hostId, registration})
      const token = await client.exchange(new URLSearchParams({grant_type:'authorization_code',code:result.code,client_id:clientId,
        code_verifier:verifier,redirect_uri:callback.uri,resource:chatgptBaseUrl}), signal)
      if (!token.id) throw signInRequired()
      const identity = await client.verifyId(token.id, clientId, nonce)
      signal.throwIfAborted()
      if (known?.subject && known.subject !== identity.subject) throw accountChanged()
      if (!canUsePlan(token.scope)) {
        store.save({hostId:original.hostId, registration:{clientId,...identity,needsConsent:true}})
        throw permissionRequired()
      }
      if (!token.refresh) throw signInRequired()
      store.save({hostId:original.hostId, registration:{clientId,...identity},
        tokens:{ access:token.access, refresh:token.refresh, id:token.id, expiresAt:token.expiresAt }})
      attempt = undefined
      return status()
    } catch (error) { throw safeError(signal.aborted ? signal.reason : error) }
    finally { clearTimeout(deadline); callback?.close(); if (attempt === controller) attempt = undefined }
  }
  async function renew(record: Account, clientId: string, old: Tokens) {
    try {
      const token = await client.exchange(new URLSearchParams({ grant_type:'refresh_token',client_id:clientId,
        refresh_token:old.refresh,resource:chatgptBaseUrl }), lifetime.signal)
      if (token.scope !== undefined && !canUsePlan(token.scope)) throw permissionRequired()
      const identity = token.id ? await client.verifyId(token.id,clientId) : undefined
      if (identity && identity.subject !== record.registration?.subject) throw accountChanged()
      if (store.read().tokens !== old || lifetime.signal.aborted) throw accountChanged()
      store.save({...record, registration:{...record.registration!,...identity},
        tokens:{access:token.access, refresh:token.refresh || old.refresh, id:token.id || old.id, expiresAt:token.expiresAt}})
    } catch (error) {
      if (error instanceof BoundaryError && ['CHATGPT_RECONNECT','CHATGPT_PERMISSION','CHATGPT_ACCOUNT_CHANGED','CHATGPT_IDENTITY'].includes(error.code) && store.read().tokens === old) {
        store.save({hostId:record.hostId, registration:error.code === 'CHATGPT_PERMISSION' ? {...record.registration!, needsConsent:true} : record.registration})
        stopSession()
      }
      throw safeError(error)
    }
  }
  async function accessToken(expected: string, signal?: AbortSignal) {
    if (signal?.aborted) throw cancelled()
    const { record, registration, tokens } = requireAccount(expected)
    if (tokens.expiresAt <= Date.now() + 60_000) {
      // 刷新令牌可能随请求轮换；并发的模型探测和推理必须共享同一次续期。
      renewing ??= renew(record,registration.clientId,tokens).finally(() => { renewing = undefined })
      await renewing
    }
    if (signal?.aborted) throw cancelled()
    return requireAccount(expected).tokens.access
  }
  async function listModels(expected: string): Promise<{id:string; name:string}[]> {
    const signal = session.signal
    const token = await accessToken(expected,signal)
    const response = await client.send(chatgptBaseUrl + '/models', {headers:{Authorization:'Bearer ' + token}}, signal)
    if (response.status === 401 || response.status === 403) throw signInRequired()
    if (!response.ok) throw new BoundaryError('CHATGPT_MODELS', '读取 ChatGPT 模型失败，请重试同步。')
    const value = await client.json(response)
    requireAccount(expected)
    if (!Array.isArray(value.models)) throw new BoundaryError('CHATGPT_MODELS', '未收到 ChatGPT 模型列表，请重试同步。')
    const seen = new Set<string>()
    return value.models.flatMap(item => {
      if (!item || item.visibility !== 'list' || typeof item.slug !== 'string' || !item.slug || seen.has(item.slug)) return []
      seen.add(item.slug)
      return [{id:item.slug,name:typeof item.display_name === 'string' && item.display_name ? item.display_name : item.slug}]
    })
  }
  function cancel() { attempt?.abort(cancelled()); attempt = undefined }
  async function disconnect() {
    cancel()
    stopSession()
    await renewing?.catch(() => {})
    const record = store.read()
    if (!record.registration) return
    if (!record.tokens) {
      if (record.registration.needsConsent) store.save({hostId:record.hostId, registration:{...record.registration, needsConsent:undefined}})
      return
    }
    try {
      await client.revoke(record.registration.clientId,record.tokens.refresh,lifetime.signal)
    } catch {
      throw new BoundaryError('CHATGPT_REVOCATION', '本机已退出，可在 ChatGPT 设置中断开 Whomi。')
    } finally {
      store.save({hostId:record.hostId, registration:record.registration})
    }
  }
  function signOut() {
    signingOut ??= disconnect().finally(() => {signingOut = undefined})
    return signingOut
  }
  function close() { cancel(); lifetime.abort(cancelled()); stopSession() }
  return {getStatus:async () => status(), signIn, cancel, signOut, accessToken, listModels, close}
}
