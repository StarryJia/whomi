import type { CatalogModel, SettingsApi, Provider, ProviderInput, SettingsSnapshot } from '../../src/shared/settings-contract'
import { failSettings, settingsId, validateProcessing, validateProvider, validateSettingsModel } from '../data/settings/validation'

export type SettingsServiceOptions = {
  storage(method: string, args: unknown[]): Promise<unknown>
  secrets: { encrypt(value: string): string; decrypt(value: string): string }
  testModel(id: string): Promise<void>
  beforeModelChange(ids: string[]): Promise<void>
  fetch?: typeof globalThis.fetch
}
export type SettingsService = Pick<SettingsApi, 'get' | 'saveProvider' | 'removeProvider' | 'saveModel' | 'removeModel' | 'syncModels' | 'testModel' | 'saveProcessing' | 'selectModel' | 'setDebug'>
const maximumCatalogBytes = 1024 * 1024

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const storage = <T>(method: string, ...args: unknown[]) => options.storage(method, args) as Promise<T>
  const get = () => storage<SettingsSnapshot>('get')
  const affected = async (id: string) => (await get()).models.filter(model => model.providerId === id).map(model => model.id)
  let mutations: Promise<unknown> = Promise.resolve()
  function mutate<T>(operation: () => Promise<T>): Promise<T> { const result = mutations.then(operation); mutations = result.catch(() => {}); return result }
  return {
    get,
    async saveProvider(input: ProviderInput) {
      validateProvider(input)
      const { apiKey, ...provider } = input
      const encryptedKey = apiKey === undefined ? undefined : apiKey ? options.secrets.encrypt(apiKey) : null
      return mutate(async () => {
        if (provider.id) {
          const previous = (await get()).providers.find(item => item.id === provider.id)
          if (!previous || previous.baseUrl !== provider.baseUrl.trim().replace(/\/+$/, '') || previous.enabled !== provider.enabled || apiKey !== undefined) await options.beforeModelChange(await affected(provider.id))
        }
        return storage<Provider>('saveProvider', provider, encryptedKey)
      })
    },
    async removeProvider(id) { settingsId(id); await mutate(async () => { await options.beforeModelChange(await affected(id)); await storage('removeProvider', id) }) },
    async saveModel(input) { validateSettingsModel(input); return mutate(async () => { if (input.id) await options.beforeModelChange([input.id]); return storage('saveModel', input) }) },
    async removeModel(id) { settingsId(id); await mutate(async () => { await options.beforeModelChange([id]); await storage('removeModel', id) }) },
    async syncModels(providerId) {
      settingsId(providerId)
      const { provider, encryptedKey } = await storage<{ provider: Provider; encryptedKey: string | null }>('providerSecret', providerId)
      validateProvider({ name: provider.name, baseUrl: provider.baseUrl, enabled: provider.enabled })
      const key = encryptedKey === null ? null : options.secrets.decrypt(encryptedKey)
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000)
      try {
        const response = await (options.fetch ?? globalThis.fetch)(`${provider.baseUrl.replace(/\/+$/, '')}/models`, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } })
        if (!response.ok || response.redirected || Number(response.headers.get('content-length') ?? 0) > maximumCatalogBytes || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error('catalog unavailable') }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maximumCatalogBytes) throw new Error('catalog too large'); chunks.push(chunk.value) }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        const catalog: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!catalog || typeof catalog !== 'object' || !('data' in catalog) || !Array.isArray(catalog.data) || catalog.data.length > 1000) throw new Error('invalid catalog')
        const entries = new Map<string, CatalogModel>()
        for (const entry of catalog.data) {
          if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128) throw new Error('invalid model')
          const model: CatalogModel = { id: entry.id.trim() }
          const label = entry.name ?? entry.label
          if (typeof label === 'string' && label.trim() && label.length <= 256) model.label = label.trim()
          if (typeof entry.group === 'string' && entry.group.length <= 256) model.group = entry.group
          for (const [field, aliases] of Object.entries({ contextWindow: ['context_length', 'contextWindow', 'context_window'], maxTokens: ['max_output_tokens', 'maxTokens', 'maxOutputTokens'], maxInputTokens: ['max_input_tokens', 'maxInputTokens'] })) {
            const value = aliases.map(alias => entry[alias]).find(value => Number.isSafeInteger(value) && value > 0 && value <= 2000000)
            if (value !== undefined) (model as Record<string, unknown>)[field] = value
          }
          entries.set(model.id, { ...model, ...entries.get(model.id) })
        }
        return [...entries.values()]
      } catch { failSettings('MODEL_SYNC_FAILED', '模型列表获取失败，请检查服务地址和密钥后重试，或手动添加模型。') }
      finally { clearTimeout(timeout) }
    },
    async testModel(id) { settingsId(id); if (!(await get()).models.some(model => model.id === id)) failSettings('INVALID_MODEL', '请保存模型后再测试连接。'); await options.testModel(id) },
    async saveProcessing(input) { validateProcessing(input); return mutate(() => storage('saveProcessing', input)) },
    async selectModel(feature, id) { if (!['analysis', 'conversation'].includes(feature)) failSettings('INVALID_ARGUMENT'); if (id !== null) settingsId(id); await mutate(() => storage('selectModel', feature, id)) },
    async setDebug(enabled) { if (typeof enabled !== 'boolean') failSettings('INVALID_ARGUMENT'); await mutate(() => storage('setDebug', enabled)) },
  }
}
