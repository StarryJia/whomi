import { randomUUID } from 'node:crypto'
import type { Store } from '../db/open'
import type { WriterQueue } from '../import/runner'
import { saveAiModelVersion } from '../ai/repository'
import type { AiModel } from '../../../src/shared/ai-contract'
import { defaultProcessing, type ModelFeature, type ProcessingSettings, type Provider, type ProviderInput, type SettingsModel, type SettingsModelInput, type SettingsSnapshot } from '../../../src/shared/settings-contract'
import { failSettings, settingsId, validateProcessing, validateProvider, validateSettingsModel } from './validation'
import { localId } from '../../../src/shared/desktop-validation'

type ProviderRow = { data: string; encrypted_key: string | null }
type ModelRow = { model_id: string; provider_id: string; enabled: bigint; data: string }
type StoredProvider = Omit<Provider, 'hasCredential'>
const schema = `
CREATE TABLE IF NOT EXISTS settings_providers(id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data)),encrypted_key TEXT) STRICT;
CREATE TABLE IF NOT EXISTS settings_models(model_id TEXT PRIMARY KEY REFERENCES ai_models(id),provider_id TEXT NOT NULL REFERENCES settings_providers(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS settings_analysis_processing(task_id INTEGER PRIMARY KEY REFERENCES ai_analysis_tasks(id) ON DELETE CASCADE,signature TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS settings_models_provider ON settings_models(provider_id);
`
export function createSettingsRepository(store: Store, write: WriterQueue) {
  const db = store.writer, reader = store.reader
  function setting<T>(key: string, fallback: T): T { const row = reader.prepare('SELECT data FROM app_settings WHERE key=?').get(key) as { data: string } | undefined; return row ? JSON.parse(row.data) as T : structuredClone(fallback) }
  function saveSetting(key: string, value: unknown) { db.prepare('INSERT INTO app_settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)) }
  function providerSecret(id: string): { provider: Provider; encryptedKey: string | null } {
    settingsId(id)
    const row = reader.prepare('SELECT data,encrypted_key FROM settings_providers WHERE id=?').get(id) as ProviderRow | undefined
    if (!row) failSettings('INVALID_PROVIDER', '请重新选择服务商。')
    return { provider: { ...JSON.parse(row.data) as StoredProvider, hasCredential: row.encrypted_key !== null }, encryptedKey: row.encrypted_key }
  }
  function modelRows(providerId?: string): ModelRow[] { return reader.prepare(`SELECT s.model_id,s.provider_id,s.enabled,m.data FROM settings_models s JOIN ai_models m ON m.id=s.model_id${providerId === undefined ? '' : ' WHERE s.provider_id=?'} ORDER BY s.model_id`).all(...(providerId === undefined ? [] : [providerId])) as ModelRow[] }
  function models(providerId?: string): SettingsModel[] { return modelRows(providerId).map(row => ({ ...JSON.parse(row.data) as AiModel, providerId: row.provider_id, enabled: row.enabled === 1n })) }
  function model(id: string): SettingsModel { settingsId(id); const value = models().find(item => item.id === id); if (!value) failSettings('INVALID_MODEL', '请重新选择模型。'); return value }
  function idle(ids: string[]) {
    const query = db.prepare("SELECT 1 FROM ai_analysis_tasks WHERE model_id=? AND state IN ('queued','running','summarizing') UNION ALL SELECT 1 FROM ai_turns WHERE model_id=? AND state IN ('queued','running','summarizing') LIMIT 1")
    if (ids.some(id => query.get(id, id))) failSettings('MODEL_BUSY', '请停止使用该模型的任务后重试。')
  }
  function secret(value: unknown) { if (value !== undefined && value !== null && (typeof value !== 'string' || !value.length || value.length > 65536)) failSettings('INVALID_PROVIDER') }
  return {
    async initialize(): Promise<void> {
      await write(() => db.transaction(() => {
        db.exec(schema)
        if (db.prepare("SELECT 1 FROM app_settings WHERE key='legacyModelsMigrated'").get()) return
        const groups = new Map<string, string>()
        for (const row of db.prepare('SELECT data,encrypted_key FROM ai_models ORDER BY id').all() as ProviderRow[]) {
          const value = JSON.parse(row.data) as AiModel, group = JSON.stringify([value.baseUrl, row.encrypted_key])
          let providerId = groups.get(group)
          if (!providerId) {
            providerId = randomUUID(); groups.set(group, providerId)
            const provider: StoredProvider = { id: providerId, name: `已导入 · ${new URL(value.baseUrl).host}`, baseUrl: value.baseUrl, enabled: true }
            db.prepare('INSERT INTO settings_providers(id,data,encrypted_key) VALUES(?,?,?)').run(providerId, JSON.stringify(provider), row.encrypted_key)
          }
          db.prepare('INSERT INTO settings_models(model_id,provider_id,enabled) VALUES(?,?,?)').run(value.id, providerId, value.enabled ? 1 : 0)
        }
        saveSetting('legacyModelsMigrated', true)
      })())
    },
    get(): SettingsSnapshot {
      const rows = reader.prepare('SELECT data,encrypted_key FROM settings_providers ORDER BY id').all() as ProviderRow[]
      return { providers: rows.map(row => ({ ...JSON.parse(row.data) as StoredProvider, hasCredential: row.encrypted_key !== null })), models: models(), processing: setting('processing', defaultProcessing), selectedModels: setting('selectedModels', {}), debug: setting('debug', false) }
    },
    providerSecret,
    async claimProcessing(taskId: string, signature: string): Promise<void> {
      if (!localId(taskId)) failSettings('INVALID_TASK')
      settingsId(signature)
      await write(() => db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM ai_analysis_tasks WHERE id=?').get(BigInt(taskId))) failSettings('INVALID_TASK')
        const previous = db.prepare('SELECT signature FROM settings_analysis_processing WHERE task_id=?').get(BigInt(taskId)) as { signature: string } | undefined
        if (previous && previous.signature !== signature) failSettings('PROCESSING_CHANGED', '消息处理设置已更新，请重新发起分析。')
        if (!previous && db.prepare('SELECT 1 FROM ai_analysis_batches WHERE task_id=? LIMIT 1').get(BigInt(taskId))) failSettings('PROCESSING_CHANGED', '请重新发起分析以应用当前消息处理设置。')
        if (!previous) db.prepare('INSERT INTO settings_analysis_processing(task_id,signature) VALUES(?,?)').run(BigInt(taskId), signature)
      })())
    },
    async saveProvider(input: ProviderInput, encryptedKey?: string | null): Promise<Provider> {
      validateProvider(input); secret(encryptedKey)
      if (Object.hasOwn(input, 'apiKey')) failSettings('INVALID_PROVIDER')
      return write(() => db.transaction(() => {
        const previous = input.id ? providerSecret(input.id) : null, providerId = input.id ?? randomUUID()
        const key = encryptedKey === undefined ? previous?.encryptedKey ?? null : encryptedKey
        const provider: StoredProvider = { id: providerId, name: input.name.trim(), baseUrl: input.baseUrl.trim().replace(/\/+$/, ''), enabled: input.enabled, ...(input.image === undefined ? {} : { image: input.image }) }
        const linked = models(providerId), changesModels = previous && (previous.provider.baseUrl !== provider.baseUrl || previous.provider.enabled !== provider.enabled || previous.encryptedKey !== key)
        if (changesModels) idle(linked.map(value => value.id))
        db.prepare('INSERT INTO settings_providers(id,data,encrypted_key) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,encrypted_key=excluded.encrypted_key').run(providerId, JSON.stringify(provider), key)
        if (changesModels) for (const value of linked) saveAiModelVersion(db, { ...value, baseUrl: provider.baseUrl, enabled: provider.enabled && value.enabled }, key)
        return { ...provider, hasCredential: key !== null }
      })())
    },
    async removeProvider(id: string): Promise<void> {
      settingsId(id)
      await write(() => db.transaction(() => {
        providerSecret(id); const linked = models(id); idle(linked.map(value => value.id))
        for (const value of linked) saveAiModelVersion(db, { ...value, enabled: false })
        db.prepare('DELETE FROM settings_models WHERE provider_id=?').run(id)
        db.prepare('DELETE FROM settings_providers WHERE id=?').run(id)
      })())
    },
    async saveModel(input: SettingsModelInput): Promise<SettingsModel> {
      validateSettingsModel(input)
      return write(() => db.transaction(() => {
        const { provider, encryptedKey } = providerSecret(input.providerId), previous = input.id ? model(input.id) : null
        if (previous && previous.providerId !== provider.id) failSettings('INVALID_MODEL')
        if (models(provider.id).some(value => value.id !== input.id && value.model === input.model.trim())) failSettings('DUPLICATE_MODEL', '该模型已添加，请修改已有模型。')
        if (previous) idle([previous.id])
        const saved = saveAiModelVersion(db, { id: input.id ?? randomUUID(), label: input.label.trim(), model: input.model.trim(), baseUrl: provider.baseUrl, contextWindow: input.contextWindow, maxTokens: input.maxTokens, enabled: provider.enabled && input.enabled }, encryptedKey)
        db.prepare('INSERT INTO settings_models(model_id,provider_id,enabled) VALUES(?,?,?) ON CONFLICT(model_id) DO UPDATE SET enabled=excluded.enabled').run(saved.id, provider.id, input.enabled ? 1 : 0)
        return { ...saved, providerId: provider.id, enabled: input.enabled }
      })())
    },
    async removeModel(id: string): Promise<void> {
      settingsId(id)
      await write(() => db.transaction(() => { const value = model(id); idle([id]); saveAiModelVersion(db, { ...value, enabled: false }); db.prepare('DELETE FROM settings_models WHERE model_id=?').run(id) })())
    },
    async saveProcessing(input: ProcessingSettings): Promise<ProcessingSettings> { validateProcessing(input); return write(() => { saveSetting('processing', input); return structuredClone(input) }) },
    async selectModel(feature: ModelFeature, id: string | null): Promise<void> {
      if (!['analysis', 'conversation'].includes(feature)) failSettings('INVALID_ARGUMENT')
      if (id !== null) settingsId(id)
      await write(() => {
        if (id !== null) { const value = model(id); if (!value.enabled || !providerSecret(value.providerId).provider.enabled) failSettings('INVALID_MODEL', '请选择已启用的模型。') }
        const selected = setting<SettingsSnapshot['selectedModels']>('selectedModels', {}); if (id === null) delete selected[feature]; else selected[feature] = id
        saveSetting('selectedModels', selected)
      })
    },
    async setDebug(enabled: boolean): Promise<void> { if (typeof enabled !== 'boolean') failSettings('INVALID_ARGUMENT'); await write(() => saveSetting('debug', enabled)) },
  }
}
export type SettingsRepository = ReturnType<typeof createSettingsRepository>
