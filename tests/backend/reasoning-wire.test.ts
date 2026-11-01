import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { createChatgptRunner } from '../../electron/main/chatgpt-responses'
import type { AiModel } from '../../src/shared/ai-contract'

const directory = mkdtempSync(join(tmpdir(), 'whomi-thinking-'))
afterEach(() => { vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }) })
const sse = (events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const events = [{type:'response.output_item.added',output_index:0,item:{id:'msg',type:'message',role:'assistant',content:[]}}, {type:'response.output_text.delta',output_index:0,content_index:0,delta:'收到'}, {type:'response.completed',response:{id:'resp',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}}]
const model: AiModel = { id:'m', label:'测试', model:'gpt-5.2', baseUrl:'https://api.openai.com/v1', protocol:'openai-responses', contextWindow:32000, maxTokens:2000, version:1, enabled:true, hasCredential:true }

test('Pi runtime sends supported effort and omits unknown effort on the actual request', async () => {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return sse(events) }))
  const runtime = new PiRuntime(directory), options = { signal: AbortSignal.timeout(15000), onText() {} }
  await runtime.run({key:'one',model,apiKey:'example',systemPrompt:'测试',prompt:'你好',thinkingLevel:'high'}, options)
  await runtime.run({key:'two',model,apiKey:'example',systemPrompt:'测试',prompt:'你好',thinkingLevel:'max'}, options)
  expect(bodies[0].reasoning).toMatchObject({effort:'high'})
  expect(bodies[1].reasoning).toBeUndefined()
}, 30000)

test('ChatGPT plan sends only a supported effort from its authorized catalog', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetcher: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(events) }
  const runner = createChatgptRunner(async () => 'example', fetcher)
  const plan = {...model, model:'catalog-only', planProvider:'openai-codex' as const, planAccount:'account', thinkingLevels:['low','high'] as const }
  const options = {signal: AbortSignal.timeout(5000), onText() {}}
  await runner.run({key:'a',model:{...plan, thinkingLevels:[...plan.thinkingLevels]},systemPrompt:'测试',prompt:'你好',thinkingLevel:'high'}, options)
  await runner.run({key:'b',model:{...plan, thinkingLevels:[...plan.thinkingLevels]},systemPrompt:'测试',prompt:'你好',thinkingLevel:'max'}, options)
  expect(bodies[0].reasoning).toEqual({effort:'high'})
  expect(bodies[1].reasoning).toBeUndefined()
})
