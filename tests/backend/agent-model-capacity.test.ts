import { expect, test, vi } from 'vitest'
import { resolveAgentModelCapacity } from '../../electron/agent/model-capacity'
import { createAiService } from '../../electron/main/ai-service'

const model = { model: 'gpt-6.1-sol', baseUrl: 'https://proxy.example/v1', contextWindow: null, maxTokens: null }

test.each([
  { model: 'qwen3.7-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai-completions', levels: ['off', 'high'] },
  { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-completions', levels: ['off', 'low', 'high', 'max'] },
  { model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', protocol: 'openai-responses', levels: ['off', 'low', 'high', 'max'] },
] as const)('选择器列出并保留 $model 的官方思考模式', async ({ model: id, baseUrl, protocol, levels }) => {
  const selected = { ...model, model: id, baseUrl, protocol, id: '1', label: '示例', version: 1, enabled: true, hasCredential: false }
  const storage = vi.fn(async (method: string, args: unknown[]) => {
    if (method === 'listModels') return [selected]
    if (method === 'modelSecret') return { model: selected, encryptedKey: null }
    if (method === 'prepareAnalysis') return args[0]
    throw Error(method)
  })
  const service = createAiService({ storage, runtime: { run: vi.fn() }, secrets: { encrypt: value => value, decrypt: value => value } })
  expect((await service.listModels())[0].thinkingLevels).toEqual(levels)
  for (const thinkingLevel of levels) {
    const choice = { conversationId: '1', modelId: '1', thinkingLevel }
    await service.prepareAnalysis(choice)
    expect(storage).toHaveBeenCalledWith('prepareAnalysis', [choice])
  }
})

test('自定义地址使用独立的未知模型输入和输出上限', async () => {
  await expect(resolveAgentModelCapacity(model)).resolves.toEqual({
    contextWindow: 256_000, maxInputTokens: 144_000, maxTokens: 128_000,
    contextSource: 'estimated', outputSource: 'estimated',
  })
})

test('官方模型按实际服务取值，订阅账号与同名开放接口独立', async () => {
  const official = { ...model, baseUrl: 'https://api.openai.com/v1/' }
  for (const protocol of ['openai-completions', 'openai-responses'] as const) {
    await expect(resolveAgentModelCapacity({ ...official, protocol })).resolves.toMatchObject({
      contextWindow: 1_050_000, maxInputTokens: 922_000, maxTokens: 128_000, contextSource: 'catalog',
    })
  }
  await expect(resolveAgentModelCapacity({ ...official, planProvider: 'openai-codex' })).resolves.toMatchObject({
    contextWindow: 500_000, maxInputTokens: 372_000, maxTokens: 128_000,
  })
  const deepseek = { ...model, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' }
  await expect(resolveAgentModelCapacity(deepseek, 'off')).resolves.toMatchObject({ contextWindow: 1_048_576, maxTokens: 393_216, requestDefaultOutputTokens: 8_192 })
  await expect(resolveAgentModelCapacity(deepseek, 'high')).resolves.toMatchObject({ maxTokens: 393_216, requestDefaultOutputTokens: 65_536 })
  await expect(resolveAgentModelCapacity(deepseek, 'max')).resolves.toMatchObject({ maxTokens: 393_216, requestDefaultOutputTokens: 131_072 })
  await expect(resolveAgentModelCapacity({ ...deepseek, protocol: 'openai-responses' }, 'max')).resolves.toMatchObject({
    contextWindow: 1_048_576, maxTokens: 393_216, requestDefaultOutputTokens: 131_072,
  })
  expect(await resolveAgentModelCapacity({ ...deepseek, maxTokens: 96_000 }, 'low')).not.toHaveProperty('requestDefaultOutputTokens')
  const qwen = { ...model, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' }
  await expect(resolveAgentModelCapacity(qwen, 'off')).resolves.toMatchObject({
    contextWindow: 1_000_000, maxInputTokens: 991_808, maxTokens: 131_072,
  })
  await expect(resolveAgentModelCapacity(qwen, 'high')).resolves.toMatchObject({ maxInputTokens: 983_616 })
  await expect(resolveAgentModelCapacity({ ...qwen, protocol: 'google-generative-ai' })).resolves.toMatchObject({ contextSource: 'estimated' })
})

test('部分容量已知时仍分别补齐上下文、输入和输出', async () => {
  await expect(resolveAgentModelCapacity({ ...model, maxInputTokens: 144_000 })).resolves.toMatchObject({
    contextWindow: 256_000, maxTokens: 128_000, maxInputTokens: 144_000,
  })
  await expect(resolveAgentModelCapacity({ ...model, contextWindow: 256_000 })).resolves.toMatchObject({ maxInputTokens: 144_000 })
  await expect(resolveAgentModelCapacity({ ...model, contextWindow: 1_000_000, maxTokens: 200_000 })).resolves.toMatchObject({ maxInputTokens: 144_000 })
  await expect(resolveAgentModelCapacity({ ...model, maxTokens: 400_000 })).rejects.toMatchObject({ code: 'INVALID_MODEL_LIMITS' })
  await expect(resolveAgentModelCapacity({ ...model, contextWindow: 128_000, maxInputTokens: 128_000, maxTokens: 16_000 })).resolves.toMatchObject({ maxInputTokens: 128_000 })
  const qwen = { ...model, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' }
  await expect(resolveAgentModelCapacity({ ...qwen, contextWindow: 1_000_000, maxInputTokens: 991_808 }, 'off')).resolves.toMatchObject({ maxTokens: 131_072 })
})
