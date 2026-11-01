import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChatgptStatus } from '../../src/shared/chatgpt-plan'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { accountId, encryptedRecord, type AuthVault } from './chatgpt-auth-store'
import { openCallback } from './chatgpt-callback'
import { createOpenAiAuthClient } from './chatgpt-oauth'
import { cherryAccountRunner, copilotBaseUrl, grokBaseUrl, type CherrySubscription, type RuntimeAccess } from './cherry-accounts-runner'

type Options = {directory:string; vault:AuthVault; clientId?:string; openBrowser:(url:string)=>Promise<void>; fetch?:typeof fetch}
type Connection = {clientId:string; subject:string; label:string; access:string; expires:number; refresh?:string}
type Grant = {subscription:Connection; credential?:RuntimeAccess & {expires:number}}
type Awaiting = {userCode:string; verificationUrl:string}
const cancelError = () => new BoundaryError('ACCOUNT_CANCELLED','已取消账户登录。')
const again = () => new BoundaryError('ACCOUNT_LOGIN','请重新登录此服务商。')
const accessDenied = () => new BoundaryError('ACCOUNT_ACCESS','此账户未获使用权限，请核对套餐与应用授权。')
const connectionError = () => new BoundaryError('ACCOUNT_NETWORK','连接服务商失败，请检查网络后重试。')
const grokIssuer = 'https://auth.x.ai'
const grokScope = 'openid profile email offline_access grok-cli:access api:access'
// Cherry Studio f19aa72 的 Grok CLI 注册表。该代理使用随应用提供的模型清单。
const grokModels = [
  ['grok-4.7','Grok 4.7'],['grok-4.7-build-fast','Grok 4.7 Fast'],['grok-4.6','Grok 4.6'],['grok-4.5','Grok 4.5'],
  ['grok-4.3','Grok 4.3'],['grok-4.20-0309-reasoning','Grok 4.20 Reasoning'],['grok-4.20-0309-non-reasoning','Grok 4.20 Non-Reasoning'],
  ['grok-4.20-multi-agent-0309','Grok 4.20 Multi-Agent'],['grok-build','Grok Build'],['grok-composer-2.5-fast','Composer 2.5 Fast'],
]
const githubApi = 'https://api.github.com'
const copilotHosts = new Set([copilotBaseUrl, ...['individual','business','enterprise'].map(plan => 'https://api.'+plan+'.githubcopilot.com')])
function field(value: unknown): value is string {return typeof value === 'string' && value.length > 0}

export function createCherryAccount(provider: CherrySubscription, options: Options) {
  const isGrok = provider === 'grok-cli'
  const envKey = isGrok ? 'WHOMI_GROK_CLIENT_ID' : 'WHOMI_COPILOT_CLIENT_ID'
  const clientId = (options.clientId ?? process.env[envKey] ?? '').trim()
  const store = encryptedRecord<Connection | null>(options.directory,options.vault,'whomi-'+provider+'-session',()=>null,value=>{
    const data=value as Connection | null
    if (data===null) return null
    if (!data || !field(data.clientId) || !field(data.subject) || !field(data.access) || typeof data.expires!=='number' || (isGrok && !field(data.refresh))) throw Error()
    return data
  })
  const request=options.fetch ?? fetch
  const oidc=createOpenAiAuthClient(request,grokIssuer)
  let attempt:AbortController|undefined, displayCode:Awaiting|undefined
  let active=new AbortController(), closed=false
  let cache: (RuntimeAccess & {expires:number}) | undefined
  let acquiring: Promise<RuntimeAccess> | undefined
  let generation=0
  function checkClient() {
    if (!clientId || !/^[a-zA-Z0-9_-]{1,256}$/.test(clientId)) throw new BoundaryError('ACCOUNT_CLIENT_REQUIRED',`请配置 Whomi 的 ${envKey} 后重启应用。`)
  }
  const identity = (record:Connection) => accountId({clientId:provider+'/'+record.clientId,subject:record.subject})
  function status():ChatgptStatus {
    if (attempt) return {state:'pending',...displayCode}
    const record=store.read()
    return record && record.clientId === clientId ? {state:'connected',accountId:identity(record),email:record.label} : {state:'disconnected'}
  }
  function requireAccount(id:string) {
    const current=store.read()
    if (closed || !current || current.clientId!==clientId) throw again()
    if (identity(current)!==id) throw new BoundaryError('ACCOUNT_CHANGED','账户已更换，请重新选择模型。')
    return current
  }
  async function json(url:string,init:RequestInit, signal:AbortSignal) {
    const response=await request(url,{...init,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)])})
    if (response.status===401 || response.status===403) throw accessDenied()
    if (!response.ok) throw connectionError()
    const data: unknown=await response.json()
    if (!data || typeof data!=='object' || Array.isArray(data)) throw connectionError()
    return data as Record<string,unknown>
  }
  const form=(values:Record<string,string>):RequestInit=>({method:'POST',headers:{Accept:'application/json','User-Agent':'Whomi'},body:new URLSearchParams(values)})
  async function githubGrant(signal:AbortSignal):Promise<Grant> {
    const device=await json('https://github.com/login/device/code',form({client_id:clientId,scope:'read:user'}),signal)
    if (!field(device.device_code) || !field(device.user_code) || device.verification_uri!=='https://github.com/login/device' ||
        typeof device.expires_in!=='number' || device.expires_in<=0) throw connectionError()
    displayCode={userCode:device.user_code,verificationUrl:device.verification_uri}
    signal.throwIfAborted()
    await options.openBrowser(device.verification_uri)
    const expiresAt=Date.now()+device.expires_in*1000
    let interval=(typeof device.interval==='number' && device.interval>=1 ? device.interval : 5)*1000
    while (Date.now()+interval < expiresAt) {
      await delay(interval,undefined,{signal})
      const result=await json('https://github.com/login/oauth/access_token',form({client_id:clientId,device_code:device.device_code,
        grant_type:'urn:ietf:params:oauth:grant-type:device_code'}),signal)
      if (result.error==='authorization_pending') continue
      if (result.error==='slow_down') {interval+=5000;continue}
      if (!field(result.access_token) || String(result.token_type).toLowerCase()!=='bearer') throw accessDenied()
      const user=await json(githubApi+'/user',{headers:{Authorization:'Bearer '+result.access_token,'User-Agent':'Whomi'}},signal)
      if (!Number.isSafeInteger(user.id) || !field(user.login)) throw again()
      const subscription:Connection={clientId,subject:String(user.id),label:user.login,access:result.access_token,
        expires:typeof result.expires_in==='number' ? Date.now()+result.expires_in*1000 : 0}
      return {subscription,credential:await copilotCredential(subscription,signal)}
    }
    throw new BoundaryError('ACCOUNT_TIMEOUT','授权码已过期，请重新登录。')
  }
  async function grokGrant(signal:AbortSignal):Promise<Grant> {
    const endpoints=await oidc.discovery(signal)
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url')
    const callback=await openCallback(state,signal,'/callback',56121)
    try {
      const url=new URL(endpoints.authorization_endpoint)
      url.search=new URLSearchParams({client_id:clientId,redirect_uri:callback.uri,response_type:'code',scope:grokScope,state,nonce,
        code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString()
      const [result]=await Promise.all([callback.result,options.openBrowser(url.href)])
      if (result.clientId && result.clientId!==clientId) throw accessDenied()
      const token=await oidc.exchange(new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:result.code,
        code_verifier:verifier,redirect_uri:callback.uri}),signal)
      if (!token.refresh || !token.id || (token.scope!==undefined && !(typeof token.scope==='string' && token.scope.split(' ').includes('grok-cli:access')))) throw accessDenied()
      const user=await oidc.verifyId(token.id,clientId,nonce)
      return {subscription:{clientId,subject:user.subject,label:user.email ?? 'Grok',access:token.access,expires:token.expiresAt,refresh:token.refresh}}
    } finally {callback.close()}
  }
  function cancel() {attempt?.abort(cancelError()); attempt=undefined; displayCode=undefined}
  async function signIn():Promise<ChatgptStatus> {
    checkClient()
    if (closed || attempt) throw new BoundaryError('ACCOUNT_BUSY','请先完成或取消当前登录。')
    if (status().state === 'connected') return status()
    const next=new AbortController();attempt=next
    const timeout=setTimeout(()=>next.abort(new BoundaryError('ACCOUNT_TIMEOUT','登录已超时，请重试。')),10*60_000)
    try {
      const result=await (isGrok?grokGrant(next.signal):githubGrant(next.signal))
      next.signal.throwIfAborted()
      store.save(result.subscription); cache=result.credential
      attempt=undefined
      return status()
    } catch(error) {
      if (next.signal.aborted) throw next.signal.reason
      if (error instanceof BoundaryError && !error.code.startsWith('CHATGPT_')) throw error
      throw new BoundaryError('ACCOUNT_LOGIN','登录失败，请核对应用授权并重试。')
    } finally {clearTimeout(timeout);if (attempt===next) {attempt=undefined;displayCode=undefined}}
  }
  async function copilotCredential(record:Connection,signal:AbortSignal) {
    if (record.expires && record.expires<=Date.now()) throw again()
    const token=await json(githubApi+'/copilot_internal/v2/token',{headers:{Authorization:'token '+record.access,'User-Agent':'Whomi',Accept:'application/json'}},signal)
    if (!field(token.token) || typeof token.expires_at!=='number' || token.expires_at*1000<=Date.now()) throw accessDenied()
    let baseUrl=copilotBaseUrl
    if (token.endpoints && typeof token.endpoints==='object' && 'api' in token.endpoints) {
      if (!field(token.endpoints.api)) throw accessDenied()
      baseUrl=token.endpoints.api.replace(/\/+$/,'')
    }
    if (!copilotHosts.has(baseUrl)) throw accessDenied()
    return {token:token.token,baseUrl,expires:token.expires_at*1000}
  }
  async function obtain(record:Connection,signal:AbortSignal):Promise<RuntimeAccess> {
    const epoch=generation
    if (!isGrok) {
      if (cache && cache.expires>Date.now()+60_000) return cache
      const credential=await copilotCredential(record,signal)
      if (generation!==epoch) throw again()
      cache=credential
      return credential
    }
    if (record.expires>Date.now()+60_000) return {token:record.access,baseUrl:grokBaseUrl}
    const token=await oidc.exchange(new URLSearchParams({grant_type:'refresh_token',refresh_token:record.refresh!,client_id:clientId}),signal)
    if (token.id && (await oidc.verifyId(token.id,clientId)).subject!==record.subject) throw again()
    if (token.scope!==undefined && !(typeof token.scope==='string' && token.scope.split(' ').includes('grok-cli:access'))) throw accessDenied()
    if (generation!==epoch) throw again()
    store.save({...record,access:token.access,expires:token.expiresAt,refresh:token.refresh || record.refresh})
    return {token:token.access,baseUrl:grokBaseUrl}
  }
  async function access(id:string, signal:AbortSignal) {
    const record=requireAccount(id)
    if (signal.aborted) throw cancelError()
    const epoch=generation
    acquiring ??= obtain(record,active.signal).catch(error=>{
      if (generation===epoch && error instanceof BoundaryError && ['CHATGPT_RECONNECT','ACCOUNT_LOGIN'].includes(error.code)) {
        store.save(null);cache=undefined
      }
      if (error instanceof BoundaryError && !error.code.startsWith('CHATGPT_')) throw error
      throw new BoundaryError('ACCOUNT_ACCESS','获取账户凭据失败，请重新登录。')
    }).finally(()=>{if (epoch===generation) acquiring=undefined})
    const result=await acquiring
    requireAccount(id)
    if (signal.aborted) throw cancelError()
    return result
  }
  async function listModels(id:string) {
    requireAccount(id)
    if (isGrok) return grokModels.map(([id,name])=>({id,name}))
    try {
      const signal=active.signal,credential=await access(id,signal)
      const catalog=await json(credential.baseUrl+'/models',{headers:{Authorization:'Bearer '+credential.token,'User-Agent':'Whomi'}},signal)
      requireAccount(id)
      if (!Array.isArray(catalog.data)) throw connectionError()
      const compatible = catalog.data.filter(item => item && field(item.id) && item.capabilities?.type === 'chat' &&
        item.policy?.state !== 'disabled' && (!Array.isArray(item.supported_endpoints) || item.supported_endpoints.includes('/chat/completions')))
      const offered = compatible.filter(item => item.model_picker_enabled === true)
      const available = !offered.length && credential.baseUrl === 'https://api.individual.githubcopilot.com'
        ? compatible.filter(item => item.policy?.state === 'enabled') : offered
      return available.map(item => ({id: String(item.id), name: field(item.name) ? String(item.name) : String(item.id)}))
    } catch(error) {if (error instanceof BoundaryError) throw error;throw connectionError()}
  }
  function reset() {cancel();generation++;active.abort(cancelError());active=new AbortController();acquiring=undefined;cache=undefined}
  async function signOut() {
    const record=store.read()
    reset()
    store.save(null)
    if (isGrok && record?.refresh) {
      try {await oidc.revoke(record.clientId,record.refresh,active.signal)}
      catch {throw new BoundaryError('ACCOUNT_REVOCATION','本机已退出，可在 xAI 账户中检查应用授权。')}
    }
  }
  function close() {closed=true;reset()}
  return {getStatus:async()=>status(),signIn,cancel,signOut,close,listModels,runner:cherryAccountRunner(provider,access,request)}
}
