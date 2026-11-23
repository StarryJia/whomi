import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createServer } from 'vite'

const project = dirname(dirname(fileURLToPath(import.meta.url)))

async function installedDatabase(profile) {
  let pointer
  try { pointer = JSON.parse(await readFile(join(profile, 'storage-location.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (pointer && (pointer.version !== 1 || typeof pointer.path !== 'string')) throw new Error('安装版资料库位置无效。')
  return join(pointer?.path ?? profile, 'whomi.db')
}

function selectedModel(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const row = database.prepare(`SELECT a.data model, json_extract(p.data,'$.name') providerName,
      json_extract(p.data,'$.baseUrl') baseUrl, json_extract(p.data,'$.protocol') protocol, a.encrypted_key encryptedKey
      FROM app_settings s JOIN ai_models a ON a.id=json_extract(s.data,'$.analysis')
      JOIN settings_models m ON m.model_id=a.id JOIN settings_providers p ON p.id=m.provider_id
      WHERE s.key='selectedModels' AND m.enabled=1 AND json_extract(p.data,'$.enabled')=1`).get()
    const model = row && JSON.parse(row.model)
    if (!model?.enabled || model.planAccount || !row.encryptedKey || model.baseUrl !== row.baseUrl ||
        (model.protocol ?? 'openai-completions') !== (row.protocol ?? 'openai-completions')) {
      throw new Error('请在安装版设置中选择已启用且已配置密钥的默认洞察模型。')
    }
    return { model, providerName: row.providerName, encryptedKey: row.encryptedKey }
  } finally { database.close() }
}

/** Prepare a new isolated desktop profile using only the installed analysis model. */
export async function prepareRealInsightProfile(profileDirectory) {
  if (process.platform !== 'win32' || !process.env.APPDATA) throw new Error('请使用安装了 Whomi 的 Windows 用户账户。')
  const modules = await createServer({ root: project, configFile: false, logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true } })
  try {
    const { validateRuntimeTestDirectory } = await modules.ssrLoadModule('/electron/runtime-test-directory.ts')
    const scratch = validateRuntimeTestDirectory(profileDirectory)
    if ((await readdir(scratch)).some(name => name !== 'probe.cjs')) throw new Error('请为本次试验建立空的桌面测试目录。')
    const installed = join(process.env.APPDATA, 'whomi')
    const { model, providerName, encryptedKey } = selectedModel(await installedDatabase(installed))
    // 与既有 Windows 试验共用系统封装密钥，明文密钥只由桌面应用在发起请求时解密。
    const state = JSON.parse(await readFile(join(installed, 'Local State'), 'utf8'))
    const wrappedKey = state.os_crypt?.encrypted_key
    if (typeof wrappedKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(wrappedKey)) throw new Error('无法取得 Windows 应用加密设置。')
    const [{ openStore }, { createSettingsRepository }] = await Promise.all([
      modules.ssrLoadModule('/electron/data/db/open.ts'), modules.ssrLoadModule('/electron/data/settings/repository.ts'),
    ])
    const store = openStore(join(scratch, 'whomi.db'))
    try {
      const settings = createSettingsRepository(store, async operation => operation())
      await settings.initialize()
      const provider = await settings.saveProvider({ name: providerName, baseUrl: model.baseUrl, protocol: model.protocol, enabled: true }, encryptedKey)
      const selected = await settings.saveModel({ providerId: provider.id, model: model.model, label: model.label,
        contextWindow: model.contextWindow ?? null, maxTokens: model.maxTokens ?? null,
        maxInputTokens: model.maxInputTokens, thinkingLevels: model.thinkingLevels, enabled: true })
      await settings.selectModel('analysis', selected.id)
      await writeFile(join(scratch, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: wrappedKey } }), { flag: 'wx' })
      return { modelId: selected.id, modelLabel: selected.label, modelName: selected.model }
    } finally { store.close() }
  } finally { await modules.close() }
}
