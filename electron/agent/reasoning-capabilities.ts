import type { AiModel } from '../../src/shared/ai-contract'
import type { ThinkingLevel } from '../../src/shared/thinking'

type ModelKey = Pick<AiModel, 'model' | 'baseUrl' | 'protocol' | 'planProvider' | 'thinkingLevels'>
let registry: Promise<{ catalog: ReturnType<typeof import('@earendil-works/pi-ai/providers/all').builtinModels>; levels: typeof import('@earendil-works/pi-ai').getSupportedThinkingLevels }> | undefined
function loadRegistry() {
  return registry ??= Promise.all([import('@earendil-works/pi-ai/providers/all'), import('@earendil-works/pi-ai')])
    .then(([providers, ai]) => ({ catalog: providers.builtinModels(), levels: ai.getSupportedThinkingLevels }))
}
export async function reasoningCapabilities(input: ModelKey) {
  const { catalog, levels } = await loadRegistry()
  const provider = input.planProvider === 'openai-codex' ? 'openai-codex' : undefined
  const model = provider ? catalog.getModel(provider, input.model) : catalog.getModels().find(item =>
    item.id === input.model && item.api === input.protocol && item.baseUrl.replace(/\/+$/, '') === input.baseUrl.replace(/\/+$/, ''))
  if (input.planProvider === 'openai-codex' && input.thinkingLevels !== undefined) return { model, levels: input.thinkingLevels }
  if (!model?.reasoning) return undefined
  return { model, levels: levels(model) as ThinkingLevel[] }
}
export async function acceptedThinking(input: ModelKey, level?: ThinkingLevel) {
  if (!level) return undefined
  const capability = await reasoningCapabilities(input)
  return capability?.levels.includes(level) ? level : undefined
}
