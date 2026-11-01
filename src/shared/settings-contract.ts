import type { ChatgptStatus, SubscriptionProviderId } from './chatgpt-plan'
import type { AiModel } from './ai-contract'
import type { ModelProtocol } from './model-protocol'

export const redactionRules = ['key', 'token', 'email', 'credit-card', 'ipv4', 'url', 'mobile', 'identity', 'bank-card', 'landline'] as const
export type RedactionRule = typeof redactionRules[number]
export type ProcessingSettings = { clean: boolean; merge: boolean; mergeSeconds: number; denoise: boolean; anonymize: boolean; redact: boolean; rules: RedactionRule[] }
export const defaultProcessing: ProcessingSettings = { clean: true, merge: true, mergeSeconds: 60, denoise: false, anonymize: true, redact: true, rules: redactionRules.filter(rule => rule !== 'ipv4' && rule !== 'url') }
export type ProviderEndpoints = Partial<Record<ModelProtocol, string>>
export type Provider = { planAccount?: string; id: string; name: string; baseUrl: string; protocol?: ModelProtocol; endpointUrls?: ProviderEndpoints; enabled: boolean; hasCredential: boolean; image?: string; avatarId?: string; notes?: string }
export type ProviderInput = Omit<Provider, 'id' | 'hasCredential' | 'planAccount'> & { id?: string; presetId?: string; apiKey?: string | null }
export function presetAccountId(presetId: string): string { return `cherry:${presetId}` }
export type SettingsModel = AiModel & { providerId: string; group?: string; maxInputTokens?: number | null }
export type SettingsModelInput = Pick<SettingsModel, 'providerId' | 'label' | 'model' | 'contextWindow' | 'maxTokens' | 'enabled' | 'group' | 'maxInputTokens' | 'thinkingLevels'> & { id?: string }
export type CatalogModel = { id: string; label?: string; group?: string; contextWindow?: number; maxTokens?: number; maxInputTokens?: number }
export type ModelFeature = 'analysis' | 'conversation'
export type SettingsSnapshot = { providers: Provider[]; models: SettingsModel[]; processing: ProcessingSettings; selectedModels: Partial<Record<ModelFeature, string>>; debug: boolean }
export type StorageLocation = { path: string; defaultPath: string; restartRequired: boolean }
export type StorageChoice = { token: string; path: string }
export type Diagnostics = { version: string; platform: string; entries: { code: string; action: string }[] }
export type AccountUsage = { requests: number; inputTokens: number | null; outputTokens: number | null; partial: boolean }
export interface SettingsApi {
  getAccountUsage(id: SubscriptionProviderId): Promise<AccountUsage>
  get(): Promise<SettingsSnapshot>
  getAccountStatus(id: SubscriptionProviderId): Promise<ChatgptStatus>
  signInAccount(id: SubscriptionProviderId, newAccount: boolean): Promise<ChatgptStatus>
  cancelAccountSignIn(id: SubscriptionProviderId): Promise<void>
  signOutAccount(id: SubscriptionProviderId): Promise<void>
  setAccountEnabled(id: SubscriptionProviderId, enabled: boolean): Promise<void>
  saveProvider(input: ProviderInput): Promise<Provider>
  removeProvider(id: string): Promise<void>
  saveModel(input: SettingsModelInput): Promise<SettingsModel>
  removeModel(id: string): Promise<void>
  syncModels(providerId: string): Promise<CatalogModel[]>
  testModel(id: string): Promise<void>
  stopModelTasks(ids: string[]): Promise<void>
  saveProcessing(input: ProcessingSettings): Promise<ProcessingSettings>
  selectModel(feature: ModelFeature, id: string | null): Promise<void>
  setDebug(enabled: boolean): Promise<void>
  getDiagnostics(): Promise<Diagnostics>
  getStorage(): Promise<StorageLocation>
  chooseStorage(): Promise<StorageChoice | null>
  relocateStorage(token: string): Promise<StorageLocation>
  restart(): Promise<void>
}
export const settingsChannel = 'whomi:settings-call'
