import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { afterEach, expect, test, vi } from 'vitest'
import { createChatgptAuth } from '../../electron/main/chatgpt-auth'
import { createChatgptRunner } from '../../electron/main/chatgpt-responses'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiService } from '../../electron/main/ai-service'
import { temporaryStore } from './helpers'
import { sourceMessages } from '../desktop/fixtures/moving-chat.mjs'
import { memoryModelReply } from '../desktop/fixtures/memory-model.mjs'

const issuer = 'https://auth.openai.com'
const resource = 'https://api.openai.com/v1'
const issuedClient = 'oaiapp_whomi_fixture'
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...keys.publicKey.export({format: 'jwk'}), kid: 'fixture', alg: 'RS256' }
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whomi-auth-fixture-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  let authorization: URL, refresh = 0, token = 0
  let modelCredential: string | null = null
  const config = { scope: scopes, nonce: '', expire: 3600, badRefresh: false, badRevoke: false, subject: 'user-one' }
  const revoke: string[] = []
  const openBrowser = vi.fn(async (url: string) => { authorization = new URL(url) })
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    const body = new URLSearchParams(String(init?.body ?? ''))
    if (path === '/.well-known/openid-configuration') return Response.json({ issuer,
      authorization_endpoint: issuer + '/api/accounts/authorize', token_endpoint: issuer + '/api/accounts/oauth/token',
      jwks_uri: issuer + '/.well-known/jwks.json', revocation_endpoint: issuer + '/revoke' })
    if (path === '/.well-known/jwks.json') return Response.json({keys:[jwk]})
    if (path === '/revoke') {
      revoke.push(body.get('token')!)
      return new Response('', { status: config.badRevoke ? 503 : 200 })
    }
    if (path === '/v1/models') {
      modelCredential = new Headers(init?.headers).get('authorization')
      return Response.json({ models:[{slug:'gpt-visible',display_name:'可用示例',visibility:'list'}, {slug:'gpt-hidden',display_name:'隐藏示例',visibility:'hide'}] })
    }
    expect(path).toBe('/api/accounts/oauth/token')
    expect(body.get('client_id')).toBe(issuedClient)
    expect(body.get('resource')).toBe(resource)
    if (body.get('grant_type') === 'refresh_token') {
      refresh++
      if (config.badRefresh) return Response.json({ error:'invalid_grant', error_description:'private-secret' }, {status:400})
      expect(body.get('refresh_token')).toBe('refresh-private-1')
      return Response.json({access_token:'access-private-2',refresh_token:'refresh-private-2',expires_in:3600,token_type:'Bearer'})
    }
    expect(body.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
    token++
    const idToken = await new SignJWT({ nonce: config.nonce || authorization.searchParams.get('nonce'), email:'tester@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid:'fixture' }).setIssuer(issuer).setSubject(config.subject)
      .setAudience(issuedClient).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
    return Response.json({id_token:idToken, access_token:'access-private-1',refresh_token:'refresh-private-1',
      scope:config.scope, expires_in:config.expire, token_type:'Bearer'})
  }
  const options = { directory, openBrowser, fetch: request, vault:{
    encrypt:(value:string)=>Buffer.from(value).toString('base64'), decrypt:(value:string)=>Buffer.from(value,'base64').toString() }}
  const auth = createChatgptAuth(options)
  cleanups.push(() => auth.close())
  async function browserLink() {
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalled())
    return authorization
  }
  async function callback(params: Record<string,string> = {}) {
    const url = await browserLink()
    const target = new URL(url.searchParams.get('redirect_uri')!)
    target.search = new URLSearchParams({ state:url.searchParams.get('state')!, client_id:issuedClient, code:'one-time-code',...params }).toString()
    return fetch(target)
  }
  return { auth,options,config,openBrowser,browserLink,callback,revoke, counters:()=>({token,refresh,modelCredential}) }
}

test('Whomi owns its browser grant, rejects unbound callbacks, and shows only the active account model catalog',async()=>{
  const f = fixture()
  expect(await f.auth.getStatus()).toEqual({state:'disconnected'})
  const done = f.auth.signIn()
  const link = await f.browserLink()
  expect(await f.auth.getStatus()).toEqual({state:'pending'})
  expect(link.origin).toBe(issuer)
  expect(link.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(link.searchParams.get('agent_name_hint')).toBe('Whomi')
  expect(link.searchParams.get('scope')?.split(' ')).toContain('chatgpt.tokens.use.direct')
  expect(link.searchParams.get('code_challenge_method')).toBe('S256')
  expect((await f.callback({state:'foreign-attempt'})).status).toBe(400)
  expect(f.counters().token).toBe(0)
  await f.callback()
  const state = await done
  expect(state).toMatchObject({state:'connected',email:'tester@example.test'})
  expect(JSON.stringify(state)).not.toContain('private')
  const saved = readdirSync(f.options.directory).map(file=>readFileSync(join(f.options.directory,file),'utf8')).join('')
  expect(saved).not.toContain('private')
  const restored = createChatgptAuth(f.options)
  expect(await restored.getStatus()).toEqual(state)
  await expect(restored.listModels('another-account')).rejects.toMatchObject({code:'CHATGPT_ACCOUNT_CHANGED'})
  expect(await restored.listModels(state.accountId!)).toEqual([{id:'gpt-visible',name:'可用示例'}])
  expect(f.counters().modelCredential).toBe('Bearer access-private-1')
  restored.close()
})

test.each(['cancel','deny','missing-scope','bad-nonce'])('cancelled and unverified sign-in never produces an active account: %s',async kind=>{
  const f = fixture()
  if (kind==='missing-scope') f.config.scope='openid profile email'
  if (kind==='bad-nonce') f.config.nonce='foreign-nonce'
  const done = expect(f.auth.signIn()).rejects.toMatchObject({code:expect.stringMatching(/^CHATGPT_/)})
  await f.browserLink()
  if (kind==='cancel') f.auth.cancel()
  else await f.callback(kind==='deny'?{error:'access_denied'}:{})
  await done
  expect((await f.auth.getStatus()).state).toBe('disconnected')
  expect(f.counters().token).toBe(kind==='deny'||kind==='cancel'?0:1)
})

test('concurrent operations refresh once, persist rotation and revoke the latest session on sign-out',async()=>{
  const f = fixture()
  f.config.expire=1
  const done=f.auth.signIn(); await f.callback()
  const account=(await done).accountId!
  expect(await Promise.all([f.auth.accessToken(account),f.auth.accessToken(account)])).toEqual(['access-private-2','access-private-2'])
  expect(f.counters().refresh).toBe(1)
  await f.auth.signOut()
  expect(f.revoke).toEqual(['refresh-private-2'])
  await expect(f.auth.accessToken(account)).rejects.toMatchObject({code:expect.stringMatching(/^CHATGPT_/)})
  expect((await createChatgptAuth(f.options).getStatus()).state).toBe('disconnected')
})

test('revoked refresh clears only Whomi credentials and returns a public recovery action',async()=>{
  const f = fixture()
  f.config.expire=1; f.config.badRefresh=true
  const done=f.auth.signIn(); await f.callback()
  const account=(await done).accountId!
  await expect(f.auth.accessToken(account)).rejects.toMatchObject({code:'CHATGPT_RECONNECT'})
  expect((await f.auth.getStatus()).state).toBe('disconnected')
})

test('same-host reauthorization uses its registered workspace and rejects substitution, explicit new account starts registration', async()=>{
  const f = fixture()
  const login = f.auth.signIn(); await f.callback()
  const first = await login
  const host = (await f.browserLink()).searchParams.get('ext_agent_host_id')
  await f.auth.signOut()
  f.openBrowser.mockClear()
  const rejected = expect(f.auth.signIn()).rejects.toMatchObject({code:'CHATGPT_ACCOUNT_CHANGED'})
  const again = await f.browserLink()
  expect(again.searchParams.get('client_id')).toBe(issuedClient)
  expect(again.searchParams.get('ext_agent_host_id')).toBe(host)
  f.config.subject='different-subject'
  await f.callback()
  await rejected
  expect((await f.auth.getStatus()).state).toBe('disconnected')
  f.openBrowser.mockClear()
  const next = f.auth.signIn(true); const fresh = await f.browserLink()
  expect(fresh.searchParams.get('client_id')).toBe('dynamic_agent_client')
  await f.callback()
  expect((await next).accountId).not.toBe(first.accountId)
})

test('identity-only consent stores verified account information without bearer credentials and re-requests plan permission after an explicit retry',async()=>{
  const f = fixture()
  f.config.scope = 'openid profile email'
  const first = expect(f.auth.signIn()).rejects.toMatchObject({code:'CHATGPT_PERMISSION'})
  const initial = await f.browserLink()
  expect(initial.searchParams.has('prompt')).toBe(false)
  await f.callback(); await first
  const restored = createChatgptAuth(f.options)
  cleanups.push(()=>restored.close())
  const state = await restored.getStatus()
  expect(state).toMatchObject({state:'disconnected',email:'tester@example.test',planPermissionNeeded:true})
  const record = JSON.parse(f.options.vault.decrypt(readFileSync(join(f.options.directory,'whomi-chatgpt-session'),'utf8')))
  expect(record.registration.subject).toBe('user-one')
  expect(record.tokens).toBeUndefined()
  await expect(restored.accessToken(state.accountId!)).rejects.toMatchObject({code:'CHATGPT_RECONNECT'})
  f.config.scope = scopes
  f.openBrowser.mockClear()
  const retry = restored.signIn()
  const url = await f.browserLink()
  expect(url.searchParams.get('client_id')).toBe(issuedClient)
  expect(url.searchParams.get('prompt')).toBe('consent')
  expect(url.searchParams.get('scope')?.split(' ')).toContain('chatgpt.tokens.use.direct')
  await f.callback()
  expect(await retry).toMatchObject({state:'connected',accountId:state.accountId})
})

test('cancel immediately frees the pending connection even when the browser launch promise has not returned', async()=>{
  const f = fixture()
  let finish!: () => void
  f.openBrowser.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve }))
  const result = expect(f.auth.signIn()).rejects.toMatchObject({code:'CHATGPT_CANCELLED'})
  await vi.waitFor(()=>expect(f.openBrowser).toHaveBeenCalled())
  f.auth.cancel()
  const status = await f.auth.getStatus()
  finish()
  await result
  expect(status.state).toBe('disconnected')
})

test('a transient remote revocation failure retries and an unconfirmed sign-out still clears the local session', async()=>{
  const f = fixture()
  const done=f.auth.signIn(); await f.callback(); await done
  f.config.badRevoke=true
  await expect(f.auth.signOut()).rejects.toMatchObject({code:'CHATGPT_REVOCATION'})
  expect(f.revoke).toEqual(['refresh-private-1', 'refresh-private-1'])
  expect((await createChatgptAuth(f.options).getStatus()).state).toBe('disconnected')
})

test('a ChatGPT-authenticated memory pauses at 8/24, rotates the protected credential after restart and only resumes the remaining messages',async()=>{
  const f = fixture()
  f.config.expire = 120
  const signedIn = f.auth.signIn()
  await f.callback()
  const account = (await signedIn).accountId!
  const temp = temporaryStore()
  cleanups.push(temp.cleanup)
  function database() {
    const db = openStore(temp.path)
    cleanups.push(() => { if (db.writer.open) db.close() })
    const write = async <T,>(operation: () => T | Promise<T>) => operation()
    return { db, ai: createAiRepository(db,write), settings: createSettingsRepository(db,write) }
  }
  const data = database()
  await data.settings.initialize()
  await data.settings.setAccountConnection('openai-codex',account,true)
  const model = await data.settings.saveModel({providerId:'cherry:openai-codex',label:'虚构套餐模型',model:'sample',enabled:true,contextWindow:3584,maxTokens:512})
  const originalVersion = model.version
  data.db.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'搬家','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人'),(2,1,1,'friend','朋友');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');`)
  const insert = data.db.writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(?,1,?,'member',?,'text',?,?,?)")
  sourceMessages.forEach((text:string,index:number) => {
    const n=index+1
    insert.run(n,n%2?1:2,n%2?'本人':'朋友','笔记'+String(n).padStart(2,'0')+' · '+text,index,1761700000000+n*120000)
  })
  const blocked = Promise.withResolvers<void>()
  const sourceRequests: string[][] = []
  let reopened = false
  const inference: typeof fetch = async (url,init) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-private-'+(reopened?'2':'1'))
    const body=JSON.parse(String(init?.body))
    const raw=JSON.parse(body.input.at(-1).content)
    if (raw.messages) {
      sourceRequests.push(raw.messages.map((message:{id:string})=>message.id))
      if (!reopened && sourceRequests.length===2) {
        blocked.resolve()
        return new Promise((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}))
      }
    }
    const answer=memoryModelReply([{content:body.instructions},body.input.at(-1)],{title:'周六搬家',text:'你们约好了取钥匙的时间。'})
    const events=[{type:'response.output_text.delta',delta:answer},{type:'response.completed',response:{status:'completed'}}]
    return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
  }
  function service(conn:ReturnType<typeof database>,auth:ReturnType<typeof createChatgptAuth>) {
    return createAiService({storage:(method,args)=>Reflect.apply(Reflect.get(conn.ai,method),conn.ai,args),
      processing:async()=>({settings:conn.settings.get().processing,members:[{id:'1',displayName:'本人'},{id:'2',displayName:'朋友'}]}),
      claimProcessing:conn.settings.claimProcessing, runtime:createChatgptRunner((id,signal)=>auth.accessToken(id,signal),inference),
      secrets:{encrypt:value=>value,decrypt:value=>value}})
  }
  let worker = service(data,f.auth)
  try {
    const prepared=await worker.prepareAnalysis({conversationId:'1',modelId:model.id})
    const task=await worker.confirmAnalysis({token:prepared.token,requestId:'signed-memory'})
    await blocked.promise
    await worker.stopAnalysis(task.id)
    await worker.idle()
    expect(data.ai.getAnalysis(task.id)).toMatchObject({state:'stopped',analyzedMessages:8,totalMessages:24})
    await worker.close();data.db.close();f.auth.close()
    const clock=Date.now()
    vi.spyOn(Date,'now').mockImplementation(()=>clock+121_000)
    reopened=true
    const conn=database(),auth=createChatgptAuth(f.options)
    cleanups.push(()=>auth.close())
    const identity=await auth.getStatus()
    await conn.settings.setAccountConnection('openai-codex',identity.accountId!)
    const checkpoint=sourceRequests.length
    worker=service(conn,auth)
    await worker.continueAnalysis(task.id)
    await worker.idle()
    expect(conn.ai.getAnalysis(task.id)).toMatchObject({id:task.id,state:'completed',analyzedMessages:24,totalMessages:24,report:{relationship:expect.any(String)}})
    expect(conn.ai.listAnalyses('1')).toHaveLength(1)
    expect(sourceRequests.slice(checkpoint).flat()).toEqual(Array.from({length:16},(_,i)=>String(i+9)))
    expect(f.counters().refresh).toBe(1)
    expect(conn.ai.modelSecret(model.id).model.version).toBe(originalVersion)
    expect(conn.ai.modelSecret(model.id).encryptedKey).toBeNull()
  } finally { await worker.close(); vi.restoreAllMocks() }
},15000)
