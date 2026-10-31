// Text endpoint mapping adapted from Cherry Studio f19aa72, customProviderCreation.ts
// and piModelCompatibility.ts (AGPL-3.0). Image endpoints are outside text generation.
export const modelProtocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const
export type ModelProtocol = typeof modelProtocols[number]
export const defaultModelProtocol: ModelProtocol = 'openai-completions'
export const modelProtocolLabels: Record<ModelProtocol, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generate Content',
}
export function isModelProtocol(value: unknown): value is ModelProtocol { return modelProtocols.includes(value as ModelProtocol) }

export function modelProtocolBaseUrl(baseUrl: string, protocol: ModelProtocol): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') return base.replace(/\/v1$/, '')
  return base
}
