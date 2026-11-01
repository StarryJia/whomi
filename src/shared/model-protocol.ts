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

export function isValidModelBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

const textRequestPaths: Record<ModelProtocol, string> = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/v1/messages',
  'google-generative-ai': '/models/{model}:streamGenerateContent',
}

export function modelRequestPreview(baseUrl: string, protocol: ModelProtocol) {
  return isValidModelBaseUrl(baseUrl) ? modelProtocolBaseUrl(baseUrl, protocol) + textRequestPaths[protocol] : ''
}
