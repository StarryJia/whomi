import { expect, test, vi } from 'vitest'
import { createSettingsService } from '../../electron/main/settings-service'
import { chatgptBaseUrl } from '../../src/shared/chatgpt-plan'

test('authorized catalog strengths are saved with an added model, and caller input cannot forge them', async () => {
  const saved: Record<string, unknown>[] = []
  const provider = {id:'cherry:openai-codex',name:'Codex',baseUrl:chatgptBaseUrl,protocol:'openai-responses',enabled:true,hasCredential:false,planAccount:'account'}
  const storage = vi.fn(async (method: string, args: unknown[]) => {
    if (method === 'providerSecret') return {provider,encryptedKey:null}
    if (method === 'get') return {providers:[provider],models:[],processing:{},selectedModels:{},debug:false}
    if (method === 'saveModel') { saved.push(args[0] as Record<string, unknown>); return args[0] }
    throw new Error(method)
  })
  const service = createSettingsService({storage, secrets:{encrypt:x=>x,decrypt:x=>x},testModel:async()=>{},beforeModelChange:async()=>{},accounts:{'openai-codex':{
    getStatus:async()=>({} as never),signIn:async()=>({} as never),cancel(){},signOut:async()=>{},
    listModels:async()=>[{id:'catalog',name:'模型',thinkingLevels:['low','high']}],
  }}})
  await service.syncModels(provider.id)
  await service.saveModel({providerId:provider.id,model:'catalog',label:'模型',contextWindow:null,maxTokens:null,enabled:true,thinkingLevels:['max']})
  await service.saveModel({providerId:provider.id,model:'unknown',label:'模型',contextWindow:null,maxTokens:null,enabled:true,thinkingLevels:['max']})
  expect(saved[0].thinkingLevels).toEqual(['low','high'])
  expect(saved[1].thinkingLevels).toBeUndefined()
})
