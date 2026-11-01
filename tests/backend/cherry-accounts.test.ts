import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimeInput } from '../../electron/main/ai-service'

const getFactory = async () => {
  const module = await import('../../electron/main/cherry-accounts').catch(() => undefined)
  expect(module?.createCherryAccount, '需要有独立于 Codex 的订阅账户服务').toBeTypeOf('function')
  return module!.createCherryAccount
}
const cleanup: Array<()=>void> = []
afterEach(()=>{ for(const run of cleanup.splice(0).reverse()) run(); vi.unstubAllEnvs() })
function options() {
  const directory = mkdtempSync(join(tmpdir(),'whomi-cherry-oauth-'))
  cleanup.push(()=>rmSync(directory,{recursive:true,force:true}))
  return {directory, clientId:'whomi-fixture', vault:{encrypt:(s:string)=>Buffer.from(s).toString('base64'),decrypt:(s:string)=>Buffer.from(s,'base64').toString()},
    openBrowser:vi.fn(async (_url:string)=>{}), fetch:vi.fn<typeof fetch>() }
}
function transcript(events:object[]) { return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}) }

test.each(['copilot','grok-cli'] as const)('unconfigured %s login stops before any browser or network activity', async provider=>{
  const create=await getFactory(),o=options(),auth=create(provider,{...o,clientId:''})
  await expect(auth.signIn()).rejects.toMatchObject({code:'ACCOUNT_CLIENT_REQUIRED'})
  expect(o.fetch).not.toHaveBeenCalled();expect(o.openBrowser).not.toHaveBeenCalled()
})

test('Copilot device authorization keeps the device secret local, exchanges with Whomi identity and only streams complete text',async()=>{
  const create=await getFactory(),o=options()
  let requests=0
  o.fetch.mockImplementation(async(url,init)=>{
    const target=String(url),headers=new Headers(init?.headers)
    expect(init?.redirect).toBe('error')
    if(target==='https://github.com/login/device/code'){
      expect(new URLSearchParams(String(init!.body)).get('client_id')).toBe(o.clientId)
      return Response.json({device_code:'device-secret',user_code:'ABCD-1234',verification_uri:'https://github.com/login/device',expires_in:120,interval:1})
    }
    if(target==='https://github.com/login/oauth/access_token'){
      expect(new URLSearchParams(String(init!.body)).get('device_code')).toBe('device-secret')
      return Response.json({access_token:'ghu_private',token_type:'bearer'})
    }
    if(target==='https://api.github.com/user') return Response.json({id:123,login:'示例账户'})
    if(target==='https://api.github.com/copilot_internal/v2/token'){
      expect(headers.get('authorization')).toContain('ghu_private');expect(headers.get('user-agent')).toMatch(/Whomi/i)
      return Response.json({token:'inference-secret',expires_at:Date.now()/1000+3600,endpoints:{api:'https://api.individual.githubcopilot.com'}})
    }
    expect(headers.get('authorization')).toBe('Bearer inference-secret')
    if(target==='https://api.individual.githubcopilot.com/models')return Response.json({data:[
      {id:'model-a',name:'Model A',model_picker_enabled:true,capabilities:{type:'chat'},supported_endpoints:['/chat/completions']},
      {id:'disabled',name:'By policy',model_picker_enabled:true,policy:{state:'disabled'},capabilities:{type:'chat'}},
      {id:'embedding',name:'Hidden',model_picker_enabled:true,capabilities:{type:'embeddings'}}]})
    expect(target).toBe('https://api.individual.githubcopilot.com/chat/completions');requests++
    return transcript([{choices:[{index:0,delta:{content:'收到'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}])
  })
  const auth=create('copilot',o);cleanup.push(()=>auth.close())
  const finished=auth.signIn();await vi.waitFor(()=>expect(o.openBrowser).toHaveBeenCalled())
  expect(await auth.getStatus()).toMatchObject({state:'pending',userCode:'ABCD-1234'})
  expect(JSON.stringify(await auth.getStatus())).not.toContain('device-secret')
  const state=await finished
  expect(state).toMatchObject({state:'connected',email:'示例账户'})
  const restored=create('copilot',o);cleanup.push(()=>restored.close())
  expect(await restored.listModels(state.accountId!)).toEqual([{id:'model-a',name:'Model A'}])
  const input={key:'c',systemPrompt:'测试',prompt:'你好',model:{model:'model-a',baseUrl:'https://api.githubcopilot.com',protocol:'openai-completions',planProvider:'copilot',planAccount:state.accountId}} as RuntimeInput
  const controls={signal:new AbortController().signal,onText:vi.fn()}
  expect((await restored.runner.run(input,controls)).text).toBe('收到');expect(requests).toBe(1)
  await expect(restored.listModels('other-account')).rejects.toMatchObject({code:'ACCOUNT_CHANGED'})
  await restored.signOut()
  expect((await restored.getStatus()).state).toBe('disconnected')
})

test('Grok uses its registered callback and fixed local catalog, sends the selected model to its own proxy',async()=>{
  vi.stubEnv('OPENAI_ORG_ID','other-provider-org'); vi.stubEnv('OPENAI_PROJECT_ID','other-provider-project')
  const create=await getFactory(),o=options(),keys=generateKeyPairSync('rsa',{modulusLength:2048})
  const issuer='https://auth.x.ai'
  let authUrl:URL
  o.openBrowser.mockImplementation(async url=>{authUrl=new URL(url)})
  o.fetch.mockImplementation(async(url,init)=>{
    const target=String(url)
    if(target===issuer+'/.well-known/openid-configuration')return Response.json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',revocation_endpoint:issuer+'/revoke'})
    if(target===issuer+'/keys')return Response.json({keys:[{...keys.publicKey.export({format:'jwk'}),alg:'RS256',kid:'example'}]})
    if(target===issuer+'/token'){
      expect(new URLSearchParams(String(init!.body)).get('client_id')).toBe(o.clientId)
      const idToken=await new SignJWT({nonce:authUrl.searchParams.get('nonce'),email:'假设@example.test'}).setProtectedHeader({alg:'RS256',kid:'example'})
        .setIssuedAt().setExpirationTime('5m').setIssuer(issuer).setSubject('first').setAudience(o.clientId).sign(keys.privateKey)
      return Response.json({id_token:idToken,access_token:'grok-access',refresh_token:'grok-refresh',expires_in:3600,token_type:'Bearer',scope:'openid profile email offline_access grok-cli:access api:access'})
    }
    expect(target).toBe('https://cli-chat-proxy.grok.com/v1/responses')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer grok-access')
    expect(new Headers(init?.headers).has('openai-organization')).toBe(false)
    expect(new Headers(init?.headers).has('openai-project')).toBe(false)
    expect(new Headers(init?.headers).get('x-grok-client-identifier')).toBe('whomi')
    expect(new Headers(init?.headers).get('x-grok-client-version')).toMatch(/^\d+\.\d+\.\d+/)
    expect(JSON.parse(String(init!.body))).toMatchObject({model:'grok-build',instructions:'测试',store:false,stream:true})
    return transcript([{type:'response.output_text.delta',delta:'好'},{type:'response.completed',response:{status:'completed'}}])
  })
  const auth=create('grok-cli',o);cleanup.push(()=>auth.close())
  const result=auth.signIn();await vi.waitFor(()=>expect(o.openBrowser).toHaveBeenCalled())
  const cb=new URL(authUrl!.searchParams.get('redirect_uri')!)
  expect(cb.href).toBe('http://127.0.0.1:56121/callback')
  cb.search=new URLSearchParams({code:'fixture',state:authUrl!.searchParams.get('state')!}).toString()
  await fetch(cb)
  const state=await result
  expect((await auth.listModels(state.accountId!)).map(item=>item.id)).toContain('grok-build')
  const input={key:'g',systemPrompt:'测试',prompt:'你好',model:{model:'grok-build',baseUrl:'https://cli-chat-proxy.grok.com/v1',protocol:'openai-responses',planProvider:'grok-cli',planAccount:state.accountId}} as RuntimeInput
  expect((await auth.runner.run(input,{signal:new AbortController().signal,onText:vi.fn()})).text).toBe('好')
})
