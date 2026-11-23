import type { AiModel } from '../../src/shared/ai-contract'
import { defaultModelProtocol, modelProtocolBaseUrl } from '../../src/shared/model-protocol'
import type { ThinkingLevel } from '../../src/shared/thinking'

type ModelKey = Pick<AiModel, 'model' | 'baseUrl' | 'protocol' | 'planProvider' | 'thinkingLevels'>
export function insightModelProtocol(input: ModelKey) {
  const api = input.protocol ?? defaultModelProtocol
  // 此模型的官方 Chat Completions 端点要求带思考的工具请求改用 Responses。
  if (!input.planProvider && api === 'openai-completions' && input.model === 'gpt-6.1-sol' &&
      modelProtocolBaseUrl(input.baseUrl, api) === 'https://api.openai.com/v1') return 'openai-responses'
  return api
}
let registry: Promise<{ catalog: ReturnType<typeof import('@earendil-works/pi-ai/providers/all').builtinModels>; levels: typeof import('@earendil-works/pi-ai').getSupportedThinkingLevels }> | undefined
function loadRegistry() {
  return registry ??= Promise.all([import('@earendil-works/pi-ai/providers/all'), import('@earendil-works/pi-ai')])
    .then(([providers, ai]) => ({ catalog: providers.builtinModels(), levels: ai.getSupportedThinkingLevels }))
}
export async function registeredModel(input: ModelKey) {
  const { catalog } = await loadRegistry()
  const provider = input.planProvider === 'openai-codex' ? 'openai-codex' : undefined
  return provider ? catalog.getModel(provider, input.model) : catalog.getModels().find(item =>
    item.id === input.model && item.api === input.protocol && item.baseUrl.replace(/\/+$/, '') === input.baseUrl.replace(/\/+$/, ''))
}
export async function reasoningCapabilities(input: ModelKey) {
  const model = await registeredModel(input)
  if (input.planProvider === 'openai-codex' && input.thinkingLevels !== undefined) return { model, levels: input.thinkingLevels }
  if (!model?.reasoning) return undefined
  const { levels } = await loadRegistry()
  return { model, levels: levels(model) as ThinkingLevel[] }
}
export async function acceptedThinking(input: ModelKey, level?: ThinkingLevel) {
  if (!level) return undefined
  const capability = await reasoningCapabilities(input)
  return capability?.levels.includes(level) ? level : undefined
}
