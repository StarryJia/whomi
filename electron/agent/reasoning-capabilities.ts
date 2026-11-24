import type { AiModel } from '../../src/shared/ai-contract'
import { defaultModelProtocol, modelProtocolBaseUrl } from '../../src/shared/model-protocol'
import type { ThinkingLevel } from '../../src/shared/thinking'
import { officialModelProfile, type ModelIdentity, type ModelReasoning } from './official-model-profile'

type ModelKey = ModelIdentity & Pick<AiModel, 'thinkingLevels'>
export function insightModelProtocol(input: ModelKey) {
  const api = input.protocol ?? defaultModelProtocol
  // 此模型的官方 Chat Completions 端点要求带思考的工具请求改用 Responses。
  if (!input.planAccount && !input.planProvider && api === 'openai-completions' && input.model === 'gpt-6.1-sol' &&
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
  const provider = input.planProvider ?? (input.planAccount ? 'openai-codex' : undefined)
  const protocol = input.protocol ?? defaultModelProtocol
  return provider === 'openai-codex' ? catalog.getModel(provider, input.model) : catalog.getModels().find(item =>
    item.id === input.model && item.api === protocol && item.baseUrl.replace(/\/+$/, '') === modelProtocolBaseUrl(input.baseUrl, protocol))
}
export async function reasoningCapabilities(input: ModelKey): Promise<ModelReasoning | undefined> {
  const official = officialModelProfile(input)?.reasoning
  if (official) return official
  const model = await registeredModel(input)
  if ((input.planProvider === 'openai-codex' || !input.planProvider && input.planAccount) && input.thinkingLevels !== undefined) return { model, levels: input.thinkingLevels }
  if (!model?.reasoning) return undefined
  const { levels } = await loadRegistry()
  return { model, levels: levels(model) as ThinkingLevel[] }
}
export async function acceptedThinking(input: ModelKey, level?: ThinkingLevel) {
  if (!level) return undefined
  const capability = await reasoningCapabilities(input)
  return capability?.levels.includes(level) ? level : undefined
}
