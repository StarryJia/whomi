import { expect, test, vi } from 'vitest'
import { createChatgptRunner } from '../../electron/main/chatgpt-responses'
import type { RuntimeInput } from '../../electron/main/ai-service'
import { BoundaryError } from '../../src/shared/desktop-validation'

const input: RuntimeInput = {
  key: 'thread', model: { id: 'local', version: 1, model: 'sample', label: '示例', baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses', enabled: true, hasCredential: true, planAccount: 'account-one', contextWindow: 8000, maxTokens: 512 },
  systemPrompt: '据实回答', history: [{ role: 'user', text: '上次的问题' }, { role: 'assistant', text: '上次的回答' }], prompt: '只回复收到',
}
function stream(events: object[]) {
  return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
}
test('ChatGPT plan inference uses only the official endpoint, streams text and requires completed inference', async () => {
  const token = vi.fn(async () => 'temporary-test-token')
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer temporary-test-token')
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'sample', instructions: '据实回答', store: false, stream: true,
      input: [{ role: 'user', content: '上次的问题' }, { role: 'assistant', content: '上次的回答' }, { role: 'user', content: '只回复收到' }] })
    return stream([{ type: 'response.output_text.delta', delta: '收' }, { type: 'response.output_text.delta', delta: '到' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 3 } } } }])
  })
  const onText = vi.fn(), signal = new AbortController().signal
  const runner = createChatgptRunner(token, fetcher)
  const result = await runner.run(input, { signal, onText })
  expect(result.text).toBe('收到')
  expect(result.usage).toMatchObject({ outputTokens: 2, totalInputTokens: 15, cacheReadTokens: 3 })
  expect(token).toHaveBeenCalledWith('account-one', signal)
  expect(onText.mock.calls).toEqual([['收'], ['收到']])
  fetcher.mockResolvedValueOnce(stream([{ type: 'response.output_text.delta', delta: '半句' }]))
  await expect(runner.run(input, { signal, onText })).rejects.toMatchObject({ code: 'CHATGPT_INCOMPLETE' })
  await expect(runner.run({ ...input, model: { ...input.model, baseUrl: 'https://example.org' } }, { signal, onText })).rejects.toMatchObject({ code: 'INVALID_MODEL' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test.each([
  ['context_length_exceeded',400,'MODEL_CONTEXT_LIMIT'],
  ['subscription_sharing_user_not_eligible',403,'CHATGPT_INELIGIBLE'],
  ['subscription_sharing_usage_limit_exceeded',429,'CHATGPT_LIMIT'],
  ['subscription_sharing_usage_unavailable',503,'CHATGPT_UNAVAILABLE'],
  ['subscription_sharing_user_unavailable',503,'CHATGPT_UNAVAILABLE'],
  ['subscription_sharing_route_not_supported',403,'CHATGPT_UNSUPPORTED'],
  ['subscription_sharing_unsupported_capability',400,'CHATGPT_UNSUPPORTED'],
  ['chatpass_v2_scope_not_authorized',403,'CHATGPT_ACCESS'],
] as const)('the same plan error %s has one actionable recovery across HTTP and both streaming failure formats', async (code,status,expected) => {
  const upstream = {code,message:'private-upstream-message'}
  const responses = [Response.json({error:upstream},{status}),stream([{type:'response.failed',response:{status:'failed',error:upstream}}]),
    stream([{type:'error',...upstream}]),new Response('event: error\ndata: '+JSON.stringify(upstream)+'\n\n',{headers:{'content-type':'text/event-stream'}})]
  const actions = []
  for (const response of responses) {
    const runner = createChatgptRunner(async ()=>'synthetic', async ()=>response)
    const error = await runner.run(input,{signal:new AbortController().signal,onText:()=>{}}).catch((cause:unknown)=>cause)
    expect(error).toBeInstanceOf(BoundaryError)
    expect(error).toMatchObject({code:expected})
    actions.push((error as BoundaryError).action)
  }
  expect(new Set(actions).size).toBe(1)
  expect(actions[0]).not.toContain(upstream.message)
})

test.each([[401,'CHATGPT_ACCESS'],[403,'CHATGPT_INELIGIBLE'],[429,'CHATGPT_LIMIT'],[503,'CHATGPT_UNAVAILABLE']] as const)(
  'direct admission status %s is actionable without an error object', async(status,code)=>{
    const runner=createChatgptRunner(async ()=>'synthetic',async()=>Response.json({detail:'private-policy-text'},{status}))
    await expect(runner.run(input,{signal:new AbortController().signal,onText:()=>{}})).rejects.toMatchObject({code})
  })

test('local action errors survive a streaming callback failure',async()=>{
  const local = new BoundaryError('SYNTHETIC_ACTION','测试恢复操作。')
  const runner = createChatgptRunner(async ()=>'synthetic',async()=>stream([{type:'response.output_text.delta',delta:'一'}]))
  await expect(runner.run(input,{signal:new AbortController().signal,onText:()=>{throw local}})).rejects.toBe(local)
})


test('explicit output exhaustion remains distinguishable from other incomplete responses with usage intact', async () => {
  const runner = createChatgptRunner(async () => 'synthetic', async () => stream([
    { type: 'response.output_text.delta', delta: '{"events":[' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 500, output_tokens: 512, input_tokens_details: { cached_tokens: 497 } } } },
  ]))
  await expect(runner.run(input, { signal: new AbortController().signal, onText() {} })).resolves.toMatchObject({ stopReason: 'length', usage: { totalInputTokens: 500, inputTokens: 3, outputTokens: 512 } })
})
