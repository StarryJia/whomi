import { expect, test } from 'vitest'
import { cherryAccountRunner, copilotBaseUrl, grokBaseUrl } from '../../electron/main/cherry-accounts-runner'
import type { RuntimeInput } from '../../electron/main/ai-service'

test.each(['copilot', 'grok-cli'] as const)('%s reports explicit output exhaustion and usage without retrying', async provider => {
  const baseUrl = provider === 'copilot' ? copilotBaseUrl : grokBaseUrl
  const input: RuntimeInput = { key: 'test', systemPrompt: '示例', prompt: '示例', model: { id: 'test', label: '示例', model: 'fixture', enabled: true, version: 1, hasCredential: false, planAccount: 'fixture', planProvider: provider, protocol: provider === 'copilot' ? 'openai-completions' : 'openai-responses', baseUrl, maxTokens: 512 } }
  const events = provider === 'copilot'
    ? [{ choices: [{ index: 0, delta: { content: '{"events":[' }, finish_reason: 'length' }] }, { choices: [], usage: { prompt_tokens: 500, completion_tokens: 512 } }]
    : [{ type: 'response.output_text.delta', delta: '{"events":[' }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 500, output_tokens: 512 } } }]
  let calls = 0
  const runner = cherryAccountRunner(provider, async () => ({ token: 'synthetic', baseUrl }), async () => {
    calls++
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  await expect(runner.run(input, { signal: new AbortController().signal, onText() {} })).resolves.toMatchObject({ stopReason: 'length', usage: { totalInputTokens: 500, outputTokens: 512 } })
  expect(calls).toBe(1)
})

test.each(['copilot', 'grok-cli'] as const)('%s forwards the output reservation without inventing missing usage', async provider => {
  const copilot = provider === 'copilot'
  const baseUrl = copilot ? copilotBaseUrl : grokBaseUrl
  const input: RuntimeInput = {
    key: 'insight', systemPrompt: '返回结构化结果', prompt: '示例', outputTokenLimit: 256,
    model: { id: 'test', label: '示例', model: 'fixture', enabled: true, version: 1, hasCredential: false,
      planAccount: 'fixture', planProvider: provider, protocol: copilot ? 'openai-completions' : 'openai-responses',
      baseUrl, contextWindow: null, maxTokens: 512 },
  }
  const text = '{"observations":[]}'
  const events = copilot
    ? [{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { completion_tokens: 12 } }]
    : [{ type: 'response.output_text.delta', delta: text },
      { type: 'response.completed', response: { status: 'completed', usage: { output_tokens: 12 } } }]
  let body: Record<string, unknown> | undefined
  const runner = cherryAccountRunner(provider, async () => ({ token: 'synthetic', baseUrl }), async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await runner.run(input, { signal: new AbortController().signal, onText() {} })
  expect(body?.[copilot ? 'max_completion_tokens' : 'max_output_tokens']).toBe(256)
  expect(JSON.parse(result.text)).toEqual({ observations: [] })
  expect(result.usage).toMatchObject({ outputTokens: 12, incomplete: true })
  expect(result.usage.inputTokens).toBeUndefined()
})
