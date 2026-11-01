import type { AccountUsage, SettingsApi, Provider, ProviderInput, SettingsSnapshot } from '../../src/shared/settings-contract'
import { failSettings, settingsId, validateProcessing, validateProvider, validateSettingsModel } from '../data/settings/validation'
import { defaultModelProtocol } from '../../src/shared/model-protocol'
import { getSubscriptionId, isSubscriptionId, type SubscriptionProviderId, type ChatgptStatus } from '../../src/shared/chatgpt-plan'
import { fetchModelCatalog } from './model-catalog'

export type SettingsServiceOptions = {
  storage(method: string, args: unknown[]): Promise<unknown>
  secrets: { encrypt(value: string): string; decrypt(value: string): string }
  testModel(id: string): Promise<void>
  beforeModelChange(ids: string[]): Promise<void>
  accounts?: Partial<Record<SubscriptionProviderId, {
    getStatus(): Promise<ChatgptStatus>
    signIn(newAccount?: boolean): Promise<ChatgptStatus>
    cancel(): void
    signOut(): Promise<void>
    listModels(accountId: string): Promise<{ id: string; name: string }[]>
  }>>
  fetch?: typeof globalThis.fetch
}
export type SettingsService = Pick<SettingsApi, 'getAccountUsage' | 'getAccountStatus' | 'signInAccount' | 'cancelAccountSignIn' | 'signOutAccount' | 'setAccountEnabled' | 'get' | 'saveProvider' | 'removeProvider' | 'saveModel' | 'removeModel' | 'syncModels' | 'testModel' | 'saveProcessing' | 'selectModel' | 'setDebug'>

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const storage = <T>(method: string, ...args: unknown[]) => options.storage(method, args) as Promise<T>
  const get = () => storage<SettingsSnapshot>('get')
  const affected = async (id: string) => (await get()).models.filter(model => model.providerId === id).map(model => model.id)
  let mutations: Promise<unknown> = Promise.resolve()
  function mutate<T>(operation: () => Promise<T>): Promise<T> { const result = mutations.then(operation); mutations = result.catch(() => {}); return result }
  function account(id: SubscriptionProviderId) {
    if (!isSubscriptionId(id)) failSettings('INVALID_PROVIDER')
    const service = options.accounts?.[id]
    if (!service) failSettings('ACCOUNT_UNAVAILABLE', '请重新打开此服务商的账户设置。')
    return service
  }
  async function reconcile(id: SubscriptionProviderId, enabled?: boolean) {
    const status = await account(id).getStatus()
    if (status.state !== 'pending') await storage('setAccountConnection', id, status.state === 'connected' ? status.accountId : null, enabled)
    return status
  }
  return {
    get,
    getAccountStatus: id => mutate(() => reconcile(id)),
    getAccountUsage: id => mutate(async () => {
      const service = account(id)
      const status = await service.getStatus()
      if (status.state !== 'connected' || !status.accountId) failSettings('ACCOUNT_LOGIN', '请先登录此账户。')
      const usage = await storage<AccountUsage>('accountUsage', id, status.accountId)
      const current = await service.getStatus()
      if (current.state !== 'connected' || current.accountId !== status.accountId) failSettings('ACCOUNT_CHANGED', '账户已变化，请重新读取用量。')
      return usage
    }),
    async signInAccount(id, newAccount) {
      if (typeof newAccount !== 'boolean') failSettings('INVALID_ARGUMENT')
      const status = await account(id).signIn(newAccount)
      if (status.state !== 'connected') return status
      return mutate(() => reconcile(id, true))
    },
    async cancelAccountSignIn(id) { account(id).cancel() },
    setAccountEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') failSettings('INVALID_ARGUMENT')
      return mutate(async () => {
        const status = await account(id).getStatus()
        if (status.state !== 'connected' || !status.accountId) failSettings('CHATGPT_LOGIN', '请登录此服务商的账户。')
        await options.beforeModelChange(await affected('cherry:' + id))
        await storage('setAccountConnection', id, status.accountId, enabled)
      })
    },
    signOutAccount(id) {
      return mutate(async () => {
        await options.beforeModelChange(await affected('cherry:' + id))
        await storage('setAccountConnection', id, null)
        await account(id).signOut()
      })
    },
    async saveProvider(input: ProviderInput) {
      validateProvider(input)
      const { apiKey, ...provider } = input
      const encryptedKey = apiKey === undefined ? undefined : apiKey ? options.secrets.encrypt(apiKey) : null
      return mutate(async () => {
        if (provider.id) {
          const previous = (await get()).providers.find(item => item.id === provider.id)
          if (!previous || previous.baseUrl !== provider.baseUrl.trim().replace(/\/+$/, '') || (provider.protocol !== undefined && (previous.protocol ?? defaultModelProtocol) !== provider.protocol) || previous.enabled !== provider.enabled || apiKey !== undefined) await options.beforeModelChange(await affected(provider.id))
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
      validateProvider({ name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, enabled: provider.enabled })
      const serviceId = getSubscriptionId(providerId)
      if (serviceId) {
        if (!provider.planAccount || !provider.enabled) failSettings('CHATGPT_LOGIN', '请登录并启用此服务商。')
        return (await account(serviceId).listModels(provider.planAccount)).map(item => ({ id: item.id, label: item.name }))
      }
      const key = encryptedKey === null ? null : options.secrets.decrypt(encryptedKey)
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000)
      try {
        return await fetchModelCatalog(provider, key, options.fetch ?? globalThis.fetch, controller.signal)
      } catch { failSettings('MODEL_SYNC_FAILED', '模型列表获取失败，请检查服务地址和密钥后重试，或手动添加模型。') }
      finally { clearTimeout(timeout) }
    },
    async testModel(id) { settingsId(id); if (!(await get()).models.some(model => model.id === id)) failSettings('INVALID_MODEL', '请保存模型后再测试连接。'); await options.testModel(id) },
    async saveProcessing(input) { validateProcessing(input); return mutate(() => storage('saveProcessing', input)) },
    async selectModel(feature, id) { if (!['analysis', 'conversation'].includes(feature)) failSettings('INVALID_ARGUMENT'); if (id !== null) settingsId(id); await mutate(() => storage('selectModel', feature, id)) },
    async setDebug(enabled) { if (typeof enabled !== 'boolean') failSettings('INVALID_ARGUMENT'); await mutate(() => storage('setDebug', enabled)) },
  }
}
