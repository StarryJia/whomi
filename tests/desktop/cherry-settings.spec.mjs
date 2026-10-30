import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Cherry settings menus, auto-save, sync recovery and capacity drawers work in the desktop window', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-cherry-settings-'))
  await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>{throw Error("Unsupported test probe")}')
  const evidence = resolve('release/cherry-settings-20261031')
  await mkdir(evidence, { recursive: true })
  let failCatalog = true
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(failCatalog ? 503 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(failCatalog ? {} : { data: [{ id: 'catalog-model', name: '目录示例模型', context_length: 200000, max_output_tokens: 32768, max_input_tokens: 150000, group: '示例模型组' }] }))
    } else { response.writeHead(404); response.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app
  try {
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
    const state = await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '本地示例服务', baseUrl, apiKey: 'synthetic-only', enabled: true })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, model: 'long-model', label: '这是用于核对真实桌面窄窗口布局的较长模型名称 Example Long Model', contextWindow: 128000, maxTokens: 16384, enabled: true })
      return { provider, model }
    }, baseUrl)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const row = page.getByRole('button', { name: '本地示例服务', exact: true })
    await row.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '编辑', exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, '01-provider-context-menu.png') })
    await page.getByRole('menuitem', { name: '备注', exact: true }).click()
    const notes = page.getByRole('dialog', { name: '备注', exact: true })
    await notes.getByRole('textbox').fill('仅用于隔离验收')
    await notes.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).providers[0].notes)).toBe('仅用于隔离验收')
    await page.getByLabel('搜索服务商', { exact: true }).fill('隔离 验收')
    await expect(row).toBeVisible()
    await page.getByRole('button', { name: '清空服务商搜索', exact: true }).click()
    const address = page.getByLabel('接口地址', { exact: true })
    await address.fill(baseUrl.replace('/v1', '/v2')); await address.press('Tab')
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).providers[0].baseUrl)).toBe(baseUrl.replace('/v1', '/v2'))
    await page.getByRole('button', { name: '同步模型', exact: true }).click()
    const catalog = page.getByRole('dialog', { name: '本地示例服务 模型', exact: true })
    await expect(catalog.getByRole('button', { name: '重试同步', exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, '02-sync-failed-retry.png') })
    failCatalog = false
    await catalog.getByRole('button', { name: '重试同步', exact: true }).click()
    await catalog.getByRole('button', { name: '添加目录示例模型', exact: true }).click()
    await expect(catalog.getByRole('button', { name: '移除目录示例模型', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).models.find(model => model.model === 'catalog-model'))).toMatchObject({ contextWindow: 200000, maxTokens: 32768, maxInputTokens: 150000, group: '示例模型组' })
    await page.screenshot({ path: join(evidence, '03-sync-added-models.png') })
    await catalog.getByRole('button', { name: `移除${state.model.label}`, exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).models.length)).toBe(1)
    await catalog.getByRole('button', { name: '关闭本地示例服务 模型', exact: true }).click()
    await page.getByRole('button', { name: '编辑目录示例模型', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '编辑模型', exact: true })
    await editor.getByRole('button', { name: '上下文长度: 256K (262144)', exact: true }).click()
    await editor.getByRole('button', { name: '最大输入长度: 128K (128000)', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).models[0])).toMatchObject({ contextWindow: 262144, maxInputTokens: 128000 })
    await page.screenshot({ path: join(evidence, '04-model-editor-presets.png') })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 320); window.setSize(360, 800) })
    await expect(editor).toBeVisible()
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, '05-narrow-model-editor.png') })
    await editor.getByRole('button', { name: '关闭编辑模型', exact: true }).click()
    await row.click()
    const add = page.getByRole('button', { name: '手动添加', exact: true })
    await add.click()
    const create = page.getByRole('dialog', { name: '手动添加模型', exact: true })
    await create.getByLabel('模型标识', { exact: true }).fill('cancel-example')
    await create.getByRole('button', { name: '取消', exact: true }).click()
    await expect(add).toBeFocused()
    expect((await page.evaluate(() => window.whomi.settings.get())).models).toHaveLength(1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
    await page.screenshot({ path: join(evidence, '06-models-minimum-desktop.png') })
    await page.getByRole('switch', { name: '启用服务商', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).providers[0].enabled)).toBe(false)
  } finally { await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
