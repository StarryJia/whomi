import { BoundaryError } from '../../../src/shared/desktop-validation'
import { redactionRules, type ProcessingSettings, type ProviderInput, type SettingsModelInput } from '../../../src/shared/settings-contract'

export function failSettings(code: string, action = '请检查设置后重试。'): never { throw new BoundaryError(code, action) }
export function settingsId(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 128) failSettings('INVALID_ID') }
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= limit }
function fields(value: unknown, allowed: string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) failSettings(code)
}
export function validateProvider(value: ProviderInput): void {
  fields(value, ['id', 'name', 'baseUrl', 'enabled', 'image', 'apiKey'], 'INVALID_PROVIDER')
  if (value.id !== undefined) settingsId(value.id)
  if (!text(value.name, 256) || !text(value.baseUrl, 2048) || typeof value.enabled !== 'boolean') failSettings('INVALID_PROVIDER')
  try { const url = new URL(value.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) failSettings('INVALID_PROVIDER') } catch { failSettings('INVALID_PROVIDER', '请输入有效的服务地址。') }
  if (value.apiKey !== undefined && value.apiKey !== null && (typeof value.apiKey !== 'string' || value.apiKey.length > 16384)) failSettings('INVALID_PROVIDER')
  if (value.image !== undefined && (typeof value.image !== 'string' || value.image.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image) || Buffer.from(value.image.slice(value.image.indexOf(',') + 1), 'base64').length > 1024 * 1024)) failSettings('INVALID_PROVIDER', '请选择不超过 1 MB 的 PNG、JPEG 或 WebP 图片。')
}
export function validateSettingsModel(value: SettingsModelInput): void {
  fields(value, ['id', 'providerId', 'label', 'model', 'contextWindow', 'maxTokens', 'enabled'], 'INVALID_MODEL')
  if (value.id !== undefined) settingsId(value.id)
  settingsId(value.providerId)
  if (!text(value.label, 256) || !text(value.model, 128) || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.contextWindow) || value.contextWindow < 256 || value.contextWindow > 2000000 || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 32 || value.maxTokens >= value.contextWindow) failSettings('INVALID_MODEL', '请填写模型标识，并将输出上限设为小于上下文容量的正整数。')
}
export function validateProcessing(value: ProcessingSettings): void {
  fields(value, ['clean', 'merge', 'mergeSeconds', 'denoise', 'anonymize', 'redact', 'rules'], 'INVALID_PROCESSING')
  if ((['clean', 'merge', 'denoise', 'anonymize', 'redact'] as const).some(key => typeof value[key] !== 'boolean') || !Number.isSafeInteger(value.mergeSeconds) || value.mergeSeconds < 1 || value.mergeSeconds > 600 || !Array.isArray(value.rules) || value.rules.length > redactionRules.length || new Set(value.rules).size !== value.rules.length || value.rules.some(rule => !redactionRules.includes(rule))) failSettings('INVALID_PROCESSING')
}
