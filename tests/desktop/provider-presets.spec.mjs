import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const providerName = '深度求索'
const customName = '自定义本机服务'
const localEndpoint = 'http://127.0.0.1:9090/v1'

test('browse offline provider presets, configure one, and retain custom accounts across restarts', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-provider-presets-'))
  const evidence = resolve('artifacts/provider-presets')
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), `module.exports = (_writer, reader) => async method => {
      if (method !== 'probe.accountCounts') throw Error('Unsupported test probe')
      return {
        providers: Number(reader.prepare('SELECT COUNT(*) AS n FROM settings_providers').get().n),
        models: Number(reader.prepare('SELECT COUNT(*) AS n FROM settings_models').get().n)
      }
    }`)

    async function launchSettings() {
      app = await electron.launch({
        ...(process.env.WHOMI_PACKAGED_EXECUTABLE
          ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
          : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
        env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
      })
      const page = await app.firstWindow()
      await page.context().setOffline(true)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByLabel('搜索服务商', { exact: true })).toBeVisible()
      return page
    }

    const counts = () => app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.accountCounts', null))
    async function resize(page, width) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(320, 320)
        window.setSize(size, 800)
      }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    }

    let page = await launchSettings()
    await resize(page, 1280)
    const registry = JSON.parse(await readFile('src/vendor/cherry-providers/registry.json', 'utf8'))
    const directoryRows = page.locator('.ms-provider-results .ms-provider-copy strong')
    await expect(directoryRows).toHaveText(registry.providers.map(preset => preset.name))
    await page.screenshot({ path: join(evidence, '01-fresh-offline-directory.png') })
    const search = page.getByLabel('搜索服务商', { exact: true })
    await search.fill('deepseek')
    const presetRow = page.getByRole('button', { name: providerName, exact: true })
    await expect.poll(() => presetRow.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
    await presetRow.click()
    const configure = page.getByRole('button', { name: '配置服务商', exact: true })
    await configure.click()
    let editor = page.getByRole('dialog')
    await expect(editor.getByLabel('接口地址', { exact: true })).toHaveValue(/^https:\/\/api\.deepseek\.com(?:\/|$)/)
    await expect(editor.getByLabel('密钥', { exact: true })).toHaveValue('')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    expect(await counts()).toEqual({ providers: 0, models: 0 })

    await page.evaluate(name => window.whomi.settings.saveProvider({
      name, enabled: true, baseUrl: 'http://127.0.0.1:8080/v1',
    }), customName)
    await app.close()
    page = await launchSettings()
    await expect(page.locator('.ms-provider-results .ms-provider').first()).toHaveAccessibleName(customName)
    await page.getByLabel('搜索服务商', { exact: true }).fill(providerName)
    await page.getByRole('button', { name: providerName, exact: true }).click()
    await resize(page, 360)
    await expect(page.getByRole('button', { name: '配置服务商', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, '02-narrow-preset-details.png') })
    await page.getByRole('button', { name: '配置服务商', exact: true }).click()
    editor = page.getByRole('dialog')
    await editor.getByLabel('接口地址', { exact: true }).fill(localEndpoint)
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(counts).toEqual({ providers: 2, models: 0 })

    await resize(page, 1280)
    await app.close()
    page = await launchSettings()
    await expect(page.getByRole('button', { name: customName, exact: true })).toHaveCount(1)
    await page.getByLabel('搜索服务商', { exact: true }).fill('deepseek')
    const savedRow = page.getByRole('button', { name: providerName, exact: true })
    await expect(savedRow).toHaveCount(1)
    await savedRow.click()
    await expect(page.getByLabel('接口地址', { exact: true })).toHaveValue(localEndpoint)
    expect(await counts()).toEqual({ providers: 2, models: 0 })
    await page.screenshot({ path: join(evidence, '03-restarted-provider-details.png') })
  } finally {
    await app?.close()
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
