import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

for (const width of [1920, 360]) test(`订阅服务商在 ${width} 像素下可登录、取消、退出和切换账号（模拟授权）`, async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-subscriptions-'))
  const evidence = resolve('artifacts/validation-0.1.8/settings')
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>true')
    app = await electron.launch({
      ...(process.env.WHOMI_PACKAGED_EXECUTABLE
        ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
        : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    const page = await app.firstWindow()
    const snapshot = await page.evaluate(() => window.whomi.settings.get())
    await app.evaluate(({ BrowserWindow, ipcMain }, { width, snapshot }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(320, 320)
      win.setSize(width, 800)
      const disconnected = { state: 'disconnected' }
      const statuses = new Map(), pending = new Map()
      globalThis.localUsageFixture = { requests:2, inputTokens:98, outputTokens:12, partial:true }
      globalThis.completeSubscriptionFixture = id => {
        const connected = { state: 'connected', accountId: 'fixture', email: '演示账号' }
        statuses.set(id, connected)
        snapshot.providers = [{ id: 'cherry:' + id, name: 'OpenAI Codex', enabled: true, hasCredential: true, planAccount: 'fixture', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' }]
        pending.get(id)(connected)
        pending.delete(id)
      }
      ipcMain.removeHandler('whomi:settings-call')
      ipcMain.handle('whomi:settings-call', async (_event, { method, args: [id, next] }) => {
        let value
        if (method === 'get') value = snapshot
        else if (method === 'getAccountStatus') value = statuses.get(id) ?? disconnected
        else if (method === 'getCodexQuota') value = disconnected
        else if (method === 'getAccountUsage') {
          if (statuses.get(id)?.state !== 'connected') throw Error('用量查询缺少当前账号')
          if (!globalThis.localUsageFixture) return {ok:false, error:{code:'READ_FAILED', action:'读取本机用量失败，请重试。'}}
          value = globalThis.localUsageFixture
        }
        else if (method === 'setAccountEnabled') snapshot.providers.find(item => item.id === 'cherry:'+id).enabled = next
        else if (method === 'syncModels') value = [{ id:'alpha', label:'本机样例模型' }]
        else if (method === 'signInAccount') {
          if (id === 'grok-cli') return { ok: false, error: { code: 'ACCOUNT_UNAVAILABLE', action: '请配置 Grok 客户端标识后重试。' } }
          globalThis.lastFixtureLogin = { id, newAccount: next }
          statuses.set(id, id === 'copilot' ? { state: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://github.com/login/device' } : { state: 'pending' })
          value = await new Promise(resolve => pending.set(id, resolve))
        } else if (method === 'cancelAccountSignIn' || method === 'signOutAccount') {
          statuses.set(id, disconnected)
          if (pending.has(id)) { pending.get(id)(disconnected); pending.delete(id) }
          snapshot.providers = snapshot.providers.filter(item => item.id !== 'cherry:' + id)
        } else throw Error('Unexpected fixture call: ' + method)
        return { ok: true, value }
      })
    }, { width, snapshot })
    const button = name => page.getByRole('button', { name, exact: true })
    const shot = name => page.screenshot({ path: join(evidence, width + '-' + name + '.png'), animations: 'disabled' })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    if (await button('展开侧栏').isVisible()) await button('展开侧栏').click()
    await button('设置').click()
    const select = async (query, name) => {
      if (await button('返回服务商').isVisible()) await button('返回服务商').click()
      await page.getByLabel('搜索服务商', { exact: true }).fill(query)
      await button(name).click()
    }
    await select('codex', 'OpenAI Codex')
    const login = button('使用 ChatGPT 登录')
    await expect(login).toBeInViewport({ ratio: 1 })
    await expect(button('同步模型')).toBeDisabled()
    await expect(page.getByText('登录后可同步账户模型。', { exact: true })).toBeVisible()
    async function verifyCenters() {
      const boxes = await page.evaluate(() => ['.ms-detail','.ms-detail-header','.account-login-card','.ms-models'].map(s => {
        const rect = document.querySelector(s).getBoundingClientRect()
        return {center: (rect.left + rect.right) / 2, width: rect.width}
      }))
      for (const box of boxes.slice(1)) {
        expect(Math.abs(box.center - boxes[0].center)).toBeLessThanOrEqual(8)
        expect(box.width).toBe(boxes[1].width)
      }
    }
    await verifyCenters()
    if (width === 1920) {
      const handle = await page.getByRole('separator', { name:'调整服务商列表宽度' }).boundingBox()
      const start = await page.locator('.ms-provider-list').boundingBox()
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 80)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + 80, {steps:6})
      await page.mouse.up()
      await expect.poll(async () => (await page.locator('.ms-provider-list').boundingBox()).width).toBeGreaterThan(start.width + 40)
      await verifyCenters()
    }
    expect(await page.locator('.account-empty-models').evaluate(el => {
      const bounds = el.getBoundingClientRect(), icon = el.querySelector('svg').getBoundingClientRect()
      return el.scrollWidth <= el.clientWidth && Math.abs((icon.left + icon.right) / 2 - (bounds.left + bounds.right) / 2) < 1
    })).toBe(true)
    await shot('01-codex-disconnected')
    await login.click()
    await expect(button('取消登录')).toBeInViewport({ ratio: 1 })
    await expect(page.getByText('授权完成后可同步模型。')).toBeVisible()
    await shot('02-codex-pending')
    await button('取消登录').click()
    await expect(login).toBeEnabled()
    await login.click()
    await expect(button('取消登录')).toBeVisible()
    await app.evaluate(() => globalThis.completeSubscriptionFixture('openai-codex'))
    await expect(button('知道了')).toBeVisible()
    await shot('03-codex-first-usage')
    await button('知道了').click()
    await expect(page.getByText('演示账号', { exact: true })).toBeVisible()
    await expect(button('同步模型')).toBeEnabled()
    await expect(page.getByRole('link', { name: '在 ChatGPT 管理用量' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
    await page.getByText('本机使用记录', { exact: true }).click()
    const usage = page.locator('.codex-local-usage')
    await expect(usage).toContainText('部分请求未返回完整用量')
    await expect(usage.getByText('98', {exact:true})).toBeVisible()
    await expect(usage.getByText('12', {exact:true})).toBeVisible()
    await shot('04-codex-connected')
    await app.evaluate(() => { globalThis.localUsageFixture = null })
    await button('刷新本机用量').click()
    await expect(usage.getByRole('alert')).toHaveText('读取本机用量失败，请重试。')
    await app.evaluate(() => { globalThis.localUsageFixture = { requests:1, inputTokens:0, outputTokens:null, partial:true } })
    await button('重读本机用量').click()
    await expect(usage.getByText('0',{exact:true})).toBeVisible()
    await expect(usage.getByText('未记录',{exact:true})).toBeVisible()
    await app.evaluate(() => { globalThis.localUsageFixture = { requests:0, inputTokens:null, outputTokens:null, partial:false } })
    await button('刷新本机用量').click()
    await expect(usage.getByText('暂无本机请求记录。')).toBeVisible()
    await page.getByRole('switch',{name:'启用服务商'}).click()
    await expect(button('同步模型')).toBeDisabled()
    await expect(page.getByText('启用服务商后可同步模型。')).toBeVisible()
    await page.getByRole('switch',{name:'启用服务商'}).click()
    await button('同步模型').click()
    await page.getByRole('button',{name:/已添加 0/}).click()
    await expect(page.getByText('还没有已添加的模型')).toBeVisible()
    await button('查看全部模型').click()
    await expect(page.getByRole('checkbox',{name:'选择本机样例模型'})).toBeVisible()
    await page.keyboard.press('Escape')
    await button('退出登录').click()
    await button('取消').click()
    await expect(button('退出登录')).toBeVisible()
    await button('退出登录').click()
    await button('确认退出').click()
    await expect(usage).toHaveCount(0)
    await button('使用其他账号登录').click()
    expect(await app.evaluate(() => globalThis.lastFixtureLogin)).toEqual({ id: 'openai-codex', newAccount: true })
    await button('取消登录').click()
    await select('copilot', 'GitHub Copilot')
    await button('使用 GitHub 登录').click()
    await expect(page.getByText('ABCD-EFGH')).toBeVisible()
    await expect(page.getByRole('link', { name: '打开 GitHub 验证页面' })).toHaveAttribute('href', 'https://github.com/login/device')
    await shot('05-copilot-device')
    await button('取消登录').click()
    await select('grok-cli', 'Grok CLI')
    await button('使用 Grok 登录').click()
    await expect(page.getByRole('alert')).toHaveText('请配置 Grok 客户端标识后重试。')
    await shot('06-grok-recovery')
    expect(await page.locator('.account-login-card').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    if (await button('分类').isVisible()) await button('分类').click()
    await button('关于 Whomi').click()
    await expect(page.getByText('从对话中找出你不曾注意的细节')).toBeVisible()
    await shot('07-about')
  } finally {
    await app?.close()
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
