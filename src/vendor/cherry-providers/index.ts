import type { ModelProtocol } from '../../shared/model-protocol'
import registry from './registry.json'

const protocols: Readonly<Record<string, ModelProtocol | undefined>> = {
  'openai-chat-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
  'google-generate-content': 'google-generative-ai',
}

const specialSetups: Readonly<Record<string, string | undefined>> = {
  'claude-code': '此预置需要 Claude Code 登录。请选择 Anthropic 使用 API 密钥连接。',
  'openai-codex': '使用 ChatGPT 账户登录。',
  'grok-cli': '使用 Grok 账户登录。',
  'aws-bedrock': '此预置需要 AWS 区域和身份认证。请选择使用 API 密钥的兼容服务商。',
  'azure-openai': '此预置需要 Azure 资源、部署和 API 版本。请选择兼容的服务地址并添加自定义服务商。',
  vertexai: '此预置需要 Google Cloud 项目、区域和身份认证。请选择 Gemini 使用 API 密钥连接。',
  copilot: '使用 GitHub 账户授权 Copilot。',
  comfyui: '此预置用于图像生成。要进行对话，请选择文本模型服务商。',
  jina: '此预置提供文档识别和检索服务。要进行对话，请选择文本模型服务商。',
  voyageai: '此预置用于向量和重排模型。要进行对话，请选择文本模型服务商。',
  gateway: '此预置使用 Vercel 专用网关端点。请用兼容 OpenAI 的地址添加自定义服务商。',
}

export interface CherryProviderPreset {
  id: string
  name: string
  sourceName: string
  baseUrl: string
  baseUrls: Partial<Record<ModelProtocol, string>>
  website: { official?: string; apiKey?: string; docs?: string; models?: string }
  protocol?: ModelProtocol
  setupNote?: string
  models: readonly { id: string; name: string }[]
}

type SourceProvider = typeof registry.providers[number]

function connectionBaseUrl(raw: string, id: string, protocol: ModelProtocol | undefined, adapterFamily: string): string {
  let base = raw.replace(/\/+$/, '')
  if (!base || !protocol || id === 'perplexity') return base
  if (base.endsWith('#')) return base.slice(0, -1)
  if (adapterFamily === 'newapi') base = base.replace(/\/v\d+(?:alpha|beta)?$/i, '')
  if (protocol === 'anthropic-messages') return base.replace(/\/v1$/, '')
  if (/\/v\d+(?:alpha|beta)?(?:\/|$)/i.test(new URL(base).pathname)) return base
  return base + (protocol === 'google-generative-ai' ? '/v1beta' : '/v1')
}

function toPreset(source: SourceProvider): CherryProviderPreset {
  const setupNote = specialSetups[source.id]
  // Ollama advertises its Anthropic-compatible route in addition to its native API.
  const route = source.defaultChatEndpoint || (source.id === 'ollama' ? 'anthropic-messages' : 'openai-chat-completions')
  const endpoint = source.endpoints.find(endpoint => endpoint.type === route) ?? source.endpoints[0]
  const protocol = setupNote ? undefined : protocols[endpoint?.type]
  const baseUrl = connectionBaseUrl(endpoint.baseUrl, source.id, protocol, endpoint.adapterFamily)
  const baseUrls: Partial<Record<ModelProtocol, string>> = {}
  if (!setupNote) {
    for (const candidate of source.endpoints) {
      const supported = protocols[candidate.type]
      // New API serves each declared protocol from the same host with a route-specific version.
      const host = candidate.baseUrl || (candidate.adapterFamily === 'newapi' ? endpoint.baseUrl : '')
      if (supported && host) {
        baseUrls[supported] = connectionBaseUrl(host, source.id, supported, candidate.adapterFamily)
      }
    }
  }
  return { id: source.id, name: source.name, sourceName: source.sourceName, baseUrl, baseUrls, protocol, website: source.website, setupNote, models: [] }
}

export const cherryProviderPresets: readonly CherryProviderPreset[] = registry.providers.map(toPreset)
const presetsById = new Map(cherryProviderPresets.map(preset => [preset.id, preset]))
export const getCherryProviderPreset = (id: string) => presetsById.get(id)
