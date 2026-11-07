import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// 正式设置页面与预加载通信；只在测试进程替换账号和模型服务，无真实授权或凭据。
for (const width of [1280, 360]) test(`订阅账号退出、重新登录和换账号在 ${width} 像素下结束旧模型界面`, async () => {
  test.setTimeout(120000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-account-models-'))
  const evidence = resolve(process.env.WHOMI_ACCOUNT_EVIDENCE || 'artifacts/account-model-lifecycle')
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
    app = await electron.launch({
      args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    let page = await app.firstWindow()
    const original = await page.evaluate(() => window.whomi.settings.get())
    await app.evaluate(({ BrowserWindow, ipcMain, shell }, { width, original }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(320, 320)
      win.setSize(width, 900)
      const providerId = 'cherry:openai-codex'
      const names = { A: '甲账号 · 虚构验收', B: '乙账号 · 虚构验收' }
      const base = { providerId, version: 1, baseUrl: 'https://chatgpt.com/backend-api/codex', protocol: 'openai-responses', contextWindow: 32000, maxTokens: 4096, group: '验收模型', planProvider: 'openai-codex' }
      const storedModels = [
        { ...base, id: 'fixture-reasoning', model: 'fixture-reasoning', label: '示例推理模型', enabled: true, planAccount: 'fixture-A' },
        { ...base, id: 'fixture-fast', model: 'fixture-fast', label: '示例快速模型', enabled: false, planAccount: 'fixture-A' },
      ]
      let account = 'A', enabled = true, status = { state: 'connected', accountId: 'fixture-A', email: names.A }
      let pendingLogin, delayRead = false
      const readers = []
      const calls = []
      const project = () => ({ ...original,
        providers: [{ id: providerId, name: 'OpenAI Codex', baseUrl: base.baseUrl, protocol: base.protocol, enabled: !!account && enabled,
          hasCredential: !!account, ...(account && { planAccount: 'fixture-' + account }) }],
        models: storedModels.map(item => ({ ...item })),
        selectedModels: {},
      })
      const settleLogin = (next, failure) => {
        const pending = pendingLogin
        if (!pending) throw new Error('No pending local fixture login')
        pendingLogin = undefined
        account = failure ? undefined : next
        status = account ? { state: 'connected', accountId: 'fixture-' + account, email: names[account] } : { state: 'disconnected' }
        if (account) storedModels.forEach(item => { item.planAccount = 'fixture-' + account })
        pending(failure ? { ok: false, error: { code: 'AUTH_FAILED', action: '登录失败，请重试。' } } : { ok: true, value: status })
      }
      globalThis.accountModelFixture = {
        calls,
        complete: next => settleLogin(next, false),
        fail: () => settleLogin(undefined, true),
        delayRead: () => { delayRead = true },
        releaseRead: () => { delayRead = false; readers.splice(0).forEach(resolve => resolve(project())) },
      }
      shell.openExternal = async url => { throw new Error('External navigation blocked in fixture: ' + new URL(url).origin) }
      ipcMain.removeHandler('whomi:settings-call')
      ipcMain.handle('whomi:settings-call', async (_event, { method, args }) => {
        calls.push({ method, args })
        const [id, next] = args
        let value
        if (method === 'get') value = delayRead && !account ? await new Promise(resolve => readers.push(resolve)) : project()
        else if (method === 'getAccountStatus') value = status
        else if (method === 'getCodexQuota') value = !account ? { state: 'disconnected' } : {
          state: 'ready', source: { email: names[account], workspaceId: '虚构工作区-' + account, authFile: 'fixture-only' },
          planType: 'fixture', windows: [{ seconds: 604800, remainingPercent: account === 'A' ? 60 : 85, resetsAt: null }], updatedAt: 1794000000000,
        }
        else if (method === 'getAccountUsage') value = { requests: account === 'A' ? 2 : 1, inputTokens: account === 'A' ? 120 : 30, outputTokens: 20, partial: false }
        else if (method === 'signInAccount') {
          status = { state: 'pending' }
          return await new Promise(resolve => { pendingLogin = resolve })
        } else if (method === 'signOutAccount' || method === 'cancelAccountSignIn') {
          account = undefined; status = { state: 'disconnected' }
          if (pendingLogin) { pendingLogin({ ok: true, value: status }); pendingLogin = undefined }
        } else if (method === 'setAccountEnabled') enabled = next
        else if (method === 'testModel') {
          if (!account || !storedModels.some(item => item.id === id)) throw new Error('No current fixture model')
        } else if (method === 'saveModel') {
          if (!account) throw new Error('No current fixture account')
          const current = storedModels.find(item => item.id === id.id)
          if (!current) throw new Error('No current fixture model')
          Object.assign(current, id)
          value = { ...current }
        } else if (method === 'syncModels') value = account ? storedModels.map(item => ({ id: item.model, label: item.label })) : []
        else if (method === 'saveProvider') value = project().providers[0]
        else throw new Error('Unexpected fixture call: ' + method)
        return { ok: true, value }
      })
    }, { width, original })
    await page.evaluate(() => localStorage.setItem('whomi:chatgpt-plan-welcome', '1'))
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const button = name => page.getByRole('button', { name, exact: true })
    const shot = name => page.screenshot({ path: join(evidence, `${width}-${name}.png`), animations: 'disabled' })
    const models = page.locator('.ms-models')
    const enterSettings = async () => {
      if (await button('展开侧栏').isVisible()) await button('展开侧栏').click()
      await button('设置').click()
      await button('OpenAI Codex').click()
      await expect(page.getByRole('region', { name: '服务商配置' })).toBeVisible()
    }
    const verifyDisconnected = async () => {
      await expect(page.locator('.ms-model-row')).toHaveCount(0)
      await expect(models.getByRole('heading', { name: '模型 0', exact: true })).toBeVisible()
      await expect(page.getByLabel('搜索已添加模型', { exact: true })).toHaveCount(0)
      await expect(models.getByRole('switch')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^编辑示例|^检测示例/ })).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: '编辑模型', exact: true })).toHaveCount(0)
      await expect(page.locator('.codex-usage')).toHaveCount(0)
      await expect(page.getByText('甲账号 · 虚构验收', { exact: true })).toHaveCount(0)
      await expect(page.getByText('乙账号 · 虚构验收', { exact: true })).toHaveCount(0)
      await expect(button('同步模型')).toBeDisabled()
      await expect(button('使用 ChatGPT 登录')).toBeEnabled()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    await enterSettings()
    await expect(page.locator('.ms-model-row')).toHaveCount(2)
    await expect(page.getByRole('switch', { name: '启用示例推理模型', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: '启用示例快速模型', exact: true })).not.toBeChecked()
    await page.getByLabel('搜索已添加模型', { exact: true }).fill('示例推理')
    await button('检测示例推理模型').click()
    await expect(page.getByText('连接成功', { exact: true })).toBeVisible()
    await shot('01-connected-models')

    await button('退出登录').click()
    await page.getByRole('dialog', { name: '退出 ChatGPT 登录？', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByLabel('搜索已添加模型', { exact: true })).toHaveValue('示例推理')
    await expect(page.getByText('连接成功', { exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: '启用示例推理模型', exact: true })).toBeChecked()
    await shot('02-cancelled-logout')

    await app.evaluate(() => globalThis.accountModelFixture.delayRead())
    await button('退出登录').click()
    await button('确认退出').click()
    try { await expect(page.locator('.ms-model-row')).toHaveCount(0) }
    catch (error) { await shot('03-logged-out-model-residue'); throw error }
    await expect(page.locator('.codex-usage')).toHaveCount(0)
    await app.evaluate(() => globalThis.accountModelFixture.releaseRead())
    await verifyDisconnected()
    await shot('03-logged-out-empty')
    await button('返回').click()
    await enterSettings()
    await verifyDisconnected()
    await shot('04-reopened-empty')

    await button('使用 ChatGPT 登录').click()
    await expect(button('取消登录')).toBeVisible()
    await button('取消登录').click()
    await verifyDisconnected()
    await shot('05-login-cancelled')
    await button('使用 ChatGPT 登录').click()
    await app.evaluate(() => globalThis.accountModelFixture.fail())
    await expect(page.getByRole('alert')).toContainText('登录失败，请重试。')
    await verifyDisconnected()
    await shot('06-login-failed')
    await button('使用 ChatGPT 登录').click()
    await app.evaluate(() => globalThis.accountModelFixture.complete('A'))
    if (await button('知道了').isVisible()) await button('知道了').click()
    await expect(page.locator('.ms-model-row')).toHaveCount(2)
    await expect(page.getByLabel('搜索已添加模型', { exact: true })).toHaveValue('')
    await expect(page.getByText('连接成功', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('switch', { name: '启用示例推理模型', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: '启用示例快速模型', exact: true })).not.toBeChecked()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await shot('07-same-account-restored')
    await page.locator('.ms-model-row').last().scrollIntoViewIfNeeded()
    await shot('07b-same-account-models')

    await page.getByLabel('搜索已添加模型', { exact: true }).fill('示例推理')
    await button('检测示例推理模型').click()
    await expect(page.getByText('连接成功', { exact: true })).toBeVisible()
    await button('退出登录').click()
    await button('确认退出').click()
    await verifyDisconnected()
    await button('使用其他账号登录').click()
    await expect(button('取消登录')).toBeVisible()
    expect(await app.evaluate(() => globalThis.accountModelFixture.calls.filter(call => call.method === 'signInAccount').at(-1).args)).toEqual(['openai-codex', true])
    await app.evaluate(() => globalThis.accountModelFixture.complete('B'))
    if (await button('知道了').isVisible()) await button('知道了').click()
    await expect(page.locator('.ms-model-row')).toHaveCount(2)
    await expect(page.getByRole('switch', { name: '启用示例推理模型', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: '启用示例快速模型', exact: true })).not.toBeChecked()
    await expect(page.getByText('甲账号 · 虚构验收', { exact: true })).toHaveCount(0)
    await expect(page.getByText('乙账号 · 虚构验收', { exact: true })).toHaveCount(2)
    await expect(page.getByLabel('搜索已添加模型', { exact: true })).toHaveValue('')
    await expect(page.getByText('连接成功', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.whomi.settings.get()).models.map(model => model.planAccount))).toEqual(['fixture-B', 'fixture-B'])
    await shot('08-account-b-current')
    await page.locator('.ms-model-row').last().scrollIntoViewIfNeeded()
    await shot('09-account-b-models')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
    await writeFile(join(evidence, `${width}-results.json`), JSON.stringify({
      width, runtimeErrors: errors,
      simulation: '正式 Electron 设置页面与既有预加载通信；测试进程模拟账号和模型调用。退出仍返回已保存模型与启用偏好，重新登录或换账号重绑定保留模型；未运行真实外部授权或真实凭据存储，也不模拟自动替换模型目录。',
      checks: ['退出取消保留模型搜索与检测', '退出立即卸载模型与额度', '退出后重新打开仍不显示保存模型', '登录取消恢复未登录界面', '登录失败可重试', '同账号恢复两项模型偏好且清理搜索检测', '换账号保留配置偏好且仅显示当前账号与额度'],
    }, null, 2))
  } finally {
    await app?.close()
    const target = resolve(directory)
    if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('whomi-runtime-account-models-')) await rm(target, { recursive: true, force: true })
  }
})
