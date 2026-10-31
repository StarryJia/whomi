import type { CatalogModel, Provider } from '../../src/shared/settings-contract'
import { defaultModelProtocol, modelProtocolBaseUrl } from '../../src/shared/model-protocol'

const maximumCatalogBytes = 1024 * 1024
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

export async function fetchModelCatalog(provider: Provider, key: string | null, fetcher: typeof fetch, signal: AbortSignal): Promise<CatalogModel[]> {
  const protocol = provider.protocol ?? defaultModelProtocol
  const base = modelProtocolBaseUrl(provider.baseUrl, protocol)
  const endpoint = `${base}${protocol === 'anthropic-messages' ? '/v1' : ''}/models`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (protocol === 'anthropic-messages') { headers['anthropic-version'] = '2023-06-01'; if (key) headers['x-api-key'] = key }
  else if (protocol === 'google-generative-ai') { if (key) headers['x-goog-api-key'] = key }
  else if (key) headers.Authorization = `Bearer ${key}`
  const entries = new Map<string, CatalogModel>(), tokens = new Set<string>()
  let next: string | undefined, bytes = 0, count = 0
  do {
    const url = new URL(endpoint)
    if (next) url.searchParams.set(protocol === 'google-generative-ai' ? 'pageToken' : 'after_id', next)
    const response = await fetcher(url.toString(), { method: 'GET', redirect: 'error', signal, headers })
    if (!response.ok || response.redirected || Number(response.headers.get('content-length') ?? 0) + bytes > maximumCatalogBytes || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error('catalog unavailable') }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maximumCatalogBytes) throw new Error('catalog too large'); chunks.push(chunk.value) }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const catalog: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!object(catalog)) throw new Error('invalid catalog')
    const values = catalog[protocol === 'google-generative-ai' ? 'models' : 'data']
    if (!Array.isArray(values) || (count += values.length) > 1000) throw new Error('invalid catalog')
    for (const entry of values) {
      if (!object(entry)) throw new Error('invalid model')
      if (protocol === 'google-generative-ai' && Array.isArray(entry.supportedGenerationMethods) && !entry.supportedGenerationMethods.includes('generateContent')) continue
      const id = protocol === 'google-generative-ai' && typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : entry.id
      if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('invalid model')
      const model: CatalogModel = { id: id.trim() }
      const label = protocol === 'google-generative-ai' ? entry.displayName : entry.display_name ?? entry.name ?? entry.label
      if (typeof label === 'string' && label.trim() && label.length <= 256) model.label = label.trim()
      if (typeof entry.group === 'string' && entry.group.length <= 256) model.group = entry.group
      for (const [field, aliases] of Object.entries({ contextWindow: ['context_length', 'contextWindow', 'context_window'], maxTokens: ['max_output_tokens', 'maxTokens', 'maxOutputTokens', 'outputTokenLimit'], maxInputTokens: ['max_input_tokens', 'maxInputTokens', 'inputTokenLimit'] })) {
        const value = aliases.map(alias => entry[alias]).find(value => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2000000)
        if (value !== undefined) (model as Record<string, unknown>)[field] = value
      }
      entries.set(model.id, { ...model, ...entries.get(model.id) })
    }
    const cursor = protocol === 'google-generative-ai' ? catalog.nextPageToken : protocol === 'anthropic-messages' && catalog.has_more === true ? catalog.last_id : undefined
    next = undefined
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      if (typeof cursor !== 'string' || cursor.length > 2048 || tokens.has(cursor) || tokens.size >= 20) throw new Error('invalid pagination')
      tokens.add(cursor); next = cursor
    } else if (protocol === 'anthropic-messages' && catalog.has_more === true) throw new Error('missing pagination')
  } while (next)
  return [...entries.values()]
}
