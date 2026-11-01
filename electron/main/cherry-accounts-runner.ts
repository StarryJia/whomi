import OpenAI from 'openai'
import { version } from '../../package.json'
import { isContextLimitCode, modelContextLimit } from '../../src/shared/model-limits'
import { BoundaryError } from '../../src/shared/desktop-validation'
import type { RuntimeRunner, RuntimeResult } from './ai-service'

export type CherrySubscription = 'grok-cli' | 'copilot'
export const grokBaseUrl = 'https://cli-chat-proxy.grok.com/v1'
export const copilotBaseUrl = 'https://api.githubcopilot.com'
export type RuntimeAccess = { token:string; baseUrl:string }

export function cherryAccountRunner(provider: CherrySubscription, access: (id: string, signal: AbortSignal) => Promise<RuntimeAccess>, request: typeof fetch): RuntimeRunner {
  return { async run(input, { signal, onText }) {
    const isGrok = provider === 'grok-cli', model = input.model
    if (model.planProvider !== provider || !model.planAccount || model.baseUrl.replace(/\/+$/, '') !== (isGrok ? grokBaseUrl : copilotBaseUrl) ||
      model.protocol !== (isGrok ? 'openai-responses' : 'openai-completions')) throw new BoundaryError('INVALID_MODEL','请重新选择此账户的模型。')
    const credential = await access(model.planAccount, signal)
    const client = new OpenAI({ apiKey:credential.token, baseURL:credential.baseUrl, organization:null, project:null, fetch:request, fetchOptions:{redirect:'error'}, maxRetries:0,
      logLevel:'off', defaultHeaders:isGrok ? {'User-Agent':'Whomi/' + version,'x-grok-client-identifier':'whomi','x-grok-client-version':version,'x-xai-token-auth':'xai-grok-cli',
        'x-authenticateresponse':'authenticate-response','x-grok-client-mode':'interactive','x-grok-model-override':model.model} : {'User-Agent':'Whomi'} })
    const history = (input.history ?? []).map(item => ({role:item.role,content:item.text}))
    const messages = [...history,{role:'user' as const,content:input.prompt}]
    const startedAt = Date.now()
    let text = '', firstTokenMs: number | undefined
    function append(delta: string) {
      if (!delta) return
      firstTokenMs ??= Date.now()-startedAt
      text += delta
      onText(text)
    }
    function finish(inputTokens?: number,outputTokens?: number): RuntimeResult {
      if (!text.trim()) throw new BoundaryError('ACCOUNT_INCOMPLETE','未收到完整回答，请重试。')
      const completedAt=Date.now(),durationMs=completedAt-startedAt
      return {text,checkpoint:'',usage:{startedAt,completedAt,durationMs,firstTokenMs,
        ...(inputTokens !== undefined && outputTokens !== undefined ? {inputTokens,totalInputTokens:inputTokens,outputTokens,outputTokensPerSecond:outputTokens/Math.max(.001,durationMs/1000)} : {incomplete:true})}}
    }
    try {
      if (isGrok) {
        const events = await client.responses.create({model:model.model,stream:true,store:false,instructions:input.systemPrompt,
          input:messages,include:['reasoning.encrypted_content']},{signal})
        for await (const event of events) {
          if (event.type==='response.output_text.delta') append(event.delta)
          else if (event.type==='response.completed' && event.response.status==='completed') return finish(event.response.usage?.input_tokens,event.response.usage?.output_tokens)
          else if ((event.type==='response.failed' && isContextLimitCode(event.response.error?.code)) || (event.type==='error' && isContextLimitCode(event.code))) throw modelContextLimit()
          else if (event.type==='response.failed' || event.type==='response.incomplete' || event.type==='error') break
        }
      } else {
        const events = await client.chat.completions.create({model:model.model,stream:true,stream_options:{include_usage:true},
          messages:[{role:'system',content:input.systemPrompt},...messages]},{signal})
        let complete=false, usage: OpenAI.CompletionUsage | null | undefined
        for await (const event of events) {
          const choice=event.choices[0]
          if (choice?.delta?.content) append(choice.delta.content)
          if (choice?.finish_reason) complete=choice.finish_reason==='stop'
          usage=event.usage ?? usage
        }
        if (complete && !signal.aborted) return finish(usage?.prompt_tokens,usage?.completion_tokens)
      }
    } catch(error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof BoundaryError) throw error
      if (error instanceof OpenAI.APIError && isContextLimitCode(error.code)) throw modelContextLimit()
      if (error instanceof OpenAI.APIError && (error.status===401 || error.status===403)) throw new BoundaryError('ACCOUNT_ACCESS','请重新登录并核对此模型的使用权限。')
      throw new BoundaryError('ACCOUNT_REQUEST','模型请求失败，请检查连接后重试。')
    }
    throw new BoundaryError('ACCOUNT_INCOMPLETE','未收到完整回答，请重试。')
  }}
}
