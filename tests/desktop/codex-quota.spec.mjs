import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

for (const width of [1280, 960, 360]) test(`方案 C 在 ${width} 像素完成连接、刷新、重试、取消与来源切换（示例数据）`, async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-quota-')), evidence = resolve('artifacts/codex-quota')
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>true')
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory, CODEX_HOME: directory } })
    const page = await app.firstWindow(), snapshot = await page.evaluate(() => window.whomi.settings.get())
    await app.evaluate(({ BrowserWindow, ipcMain }, { width, snapshot }) => {
      BrowserWindow.getAllWindows()[0].setMinimumSize(320, 320)
      BrowserWindow.getAllWindows()[0].setSize(width, 900)
      snapshot.providers.push({ id: 'cherry:openai-codex', name: 'OpenAI Codex', enabled: true, hasCredential: true, planAccount: 'fixture', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' })
      const ready = { state: 'ready', source: { email: 'demo@example.invalid', workspaceId: 'sample-workspace-0000-1111-2222-333344445555', authFile: 'C:/Example/.codex/auth.json' }, planType: 'prolite', windows: [{ seconds: 604800, remainingPercent: 62, resetsAt: 1794130454000 }], updatedAt: 1793549700000 }
      globalThis.quotaFixture = { mode: 'weekly', connected: false, pending: null }
      ipcMain.removeHandler('whomi:settings-call')
      ipcMain.handle('whomi:settings-call', async (_event, { method, args }) => {
        let value
        const fixture = globalThis.quotaFixture
        if (method === 'get') value = snapshot
        else if (method === 'getAccountStatus') value = { state: 'connected', accountId: 'fixture', email: 'whomi@example.invalid' }
        else if (method === 'getAccountUsage') value = { requests: 10, inputTokens: 603141, outputTokens: 44980, partial: false }
        else if (method === 'getCodexQuota') {
          const action = args[1]
          if (action === 'disconnect') { fixture.connected = false; fixture.pending?.({ state: 'disconnected' }); fixture.pending = null; value = { state: 'disconnected' } }
          else if (action === 'read' && !fixture.connected) value = { state: 'disconnected' }
          else if (fixture.mode === 'pending') value = await new Promise(done => { fixture.pending = done })
          else if (fixture.mode === 'failure') return { ok: false, error: { code: 'CODEX_QUOTA_NETWORK', action: '读取额度失败，请检查网络后重试。' } }
          else if (fixture.mode === 'changed') value = { state: 'unavailable', reason: 'source-changed' }
          else { fixture.connected = true; value = structuredClone(ready); if (fixture.mode === 'plus') { value.windows.unshift({ seconds: 18000, remainingPercent: 0, resetsAt: null }); value.planType = 'plus' } }
        } else throw Error('Unexpected quota fixture call')
        return { ok: true, value }
      })
    }, { width, snapshot })
    const button = name => page.getByRole('button', { name, exact: true })
    const mode = value => app.evaluate((_electron, value) => { globalThis.quotaFixture.mode = value }, value)
    const shot = async name => {
      await page.screenshot({ path: join(evidence, `${width}-${name}.png`), animations: 'disabled' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const overflow = await page.locator('.codex-usage').evaluate(el => {
        if (el.scrollWidth <= el.clientWidth) return []
        const bounds = el.getBoundingClientRect()
        return [...el.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > bounds.right + 1).map(child => ({ tag: child.tagName, class: child.className, width: child.getBoundingClientRect().width }))
      })
      expect(overflow).toEqual([])
    }
    if (await button('展开侧栏').isVisible()) await button('展开侧栏').click()
    await button('设置').click()
    await page.getByLabel('搜索服务商', { exact: true }).fill('codex')
    await button('OpenAI Codex').click()
    await expect(button('连接本机 Codex 用量')).toBeVisible()
    await shot('disconnected')
    await button('连接本机 Codex 用量').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('meter', { name: '每周额度' })).toHaveAttribute('aria-valuenow', '62')
    await expect(button('刷新额度')).toBeFocused()
    await expect(page.getByRole('meter')).toHaveCount(1)
    await shot('pro')
    await page.getByText('本机使用记录', { exact: true }).click()
    expect(await page.locator('.codex-usage').evaluate(el => new Promise(resolve => {
      const start = performance.now(); let overflow = false
      const check = () => { overflow ||= el.scrollWidth > el.clientWidth; if (performance.now() - start < 250) requestAnimationFrame(check); else resolve(overflow) }
      check()
    }))).toBe(false)
    await expect(page.getByText('603,141')).toBeVisible()
    await shot('local-records')
    await page.getByText('本机使用记录', { exact: true }).click()
    await mode('failure')
    await button('刷新额度').click()
    await expect(page.getByRole('alert')).toContainText('上次结果')
    await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '62')
    await shot('retry')
    await mode('plus')
    await button('重试读取额度').click()
    await expect(page.getByRole('meter', { name: '5 小时额度' })).toHaveAttribute('aria-valuenow', '0')
    await expect(page.getByText('重置时间未提供')).toBeVisible()
    await shot('plus-zero')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.locator('.codex-quota-track > span').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
    await mode('changed')
    await button('刷新额度').click()
    await expect(page.getByRole('meter')).toHaveCount(0)
    await expect(button('断开')).toBeVisible()
    await shot('changed')
    await button('断开').click()
    await mode('pending')
    await button('连接本机 Codex 用量').click()
    await expect(button('取消连接')).toBeFocused()
    await shot('connecting')
    await button('取消连接').click()
    await expect(button('连接本机 Codex 用量')).toBeFocused()
    await expect(page.getByRole('meter')).toHaveCount(0)
    await mode('weekly')
    await button('连接本机 Codex 用量').click()
    await expect(page.getByRole('meter')).toHaveCount(1)
  } finally {
    await app?.close()
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('whomi-runtime-quota-')) await rm(directory, { recursive: true, force: true })
  }
})
