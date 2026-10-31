import type { AiModel } from './ai-contract'
import type { ModelProtocol } from './model-protocol'

export const redactionRules = ['key', 'token', 'email', 'credit-card', 'ipv4', 'url', 'mobile', 'identity', 'bank-card', 'landline'] as const
export type RedactionRule = typeof redactionRules[number]
export type ProcessingSettings = { clean: boolean; merge: boolean; mergeSeconds: number; denoise: boolean; anonymize: boolean; redact: boolean; rules: RedactionRule[] }
export const defaultProcessing: ProcessingSettings = { clean: true, merge: true, mergeSeconds: 60, denoise: false, anonymize: true, redact: true, rules: redactionRules.filter(rule => rule !== 'ipv4' && rule !== 'url') }
export type Provider = { id: string; name: string; baseUrl: string; protocol?: ModelProtocol; enabled: boolean; hasCredential: boolean; image?: string; notes?: string }
export type ProviderInput = Omit<Provider, 'id' | 'hasCredential'> & { id?: string; apiKey?: string | null }
export type SettingsModel = AiModel & { providerId: string; group?: string; maxInputTokens?: number | null }
export type SettingsModelInput = Pick<SettingsModel, 'providerId' | 'label' | 'model' | 'contextWindow' | 'maxTokens' | 'enabled' | 'group' | 'maxInputTokens'> & { id?: string }
export type CatalogModel = { id: string; label?: string; group?: string; contextWindow?: number; maxTokens?: number; maxInputTokens?: number }
export type ModelFeature = 'analysis' | 'conversation'
export type SettingsSnapshot = { providers: Provider[]; models: SettingsModel[]; processing: ProcessingSettings; selectedModels: Partial<Record<ModelFeature, string>>; debug: boolean }
export type StorageLocation = { path: string; defaultPath: string; restartRequired: boolean }
export type StorageChoice = { token: string; path: string }
export type Diagnostics = { version: string; platform: string; entries: { code: string; action: string }[] }
export interface SettingsApi {
  get(): Promise<SettingsSnapshot>
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
