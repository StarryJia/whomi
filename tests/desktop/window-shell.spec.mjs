import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('desktop shell opens at a readable size, preserves bounds, and shows the refined conversation UI', async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  const version = JSON.parse(await readFile('package.json', 'utf8')).version
  const evidence = resolve(`release/validation-${version}`)
  await mkdir(evidence, { recursive: true })
  const launch = () => electron.launch({
    ...(process.env.WHOMI_PACKAGED_EXECUTABLE
      ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
      : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
    env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  })
  let application
  try {
    await writeFile(join(directory, 'probe.cjs'), `module.exports=writer=>async method=>{
      if(method!=='probe.shellSeed')throw Error('Unsupported');
      writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'界面验证 · 虚构会话','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
      INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','明晚九点我听你讲',0);\`); return true;
    }`)
    application = await launch()
    let page = await application.firstWindow()
    await page.locator('.hello-cover').waitFor({ state: 'attached' })
    await expect(page.locator('.startup-intro')).toHaveCount(0, { timeout: 10000 })
    const state = await application.evaluate(({ BrowserWindow, Menu, screen, app }) => ({
      bounds: BrowserWindow.getAllWindows()[0].getBounds(), area: screen.getPrimaryDisplay().workArea,
      noMenu: Menu.getApplicationMenu() === null, version: app.getVersion(),
    }))
    expect(state.noMenu).toBe(true)
    expect([version, '45.1.0']).toContain(state.version)
    if (process.env.WHOMI_PACKAGED_EXECUTABLE) expect(state.version).toBe(version)
    expect(state.bounds.width).toBe(Math.min(1200, state.area.width))
    expect(state.bounds.height).toBe(Math.min(800, state.area.height))
    await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
    expect(await page.locator('.sidebar-header').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('drag')
    expect(await page.locator('.desktop-drag-strip').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('drag')
    expect(await page.locator('.brand-link').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
    expect(await page.locator('.header-toggle').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
    expect(await page.locator('.greeting').evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
    await page.screenshot({ path: join(evidence, 'hello.png') })
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: /进入个人总览/ }).focus()
    expect(await page.locator('.greeting').evaluate(element => getComputedStyle(element).outlineWidth)).toBe('2px')
    await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.shellSeed', null))
    const configuredModel = await page.evaluate(async () => {
      const provider = await window.whomi.settings.saveProvider({ name: '界面验证服务', baseUrl: 'http://127.0.0.1:9/v1', enabled: true })
      const saved = await window.whomi.settings.saveModel({ providerId: provider.id, label: '界面验证模型', model: 'example', contextWindow: 8000, maxTokens: 1000, enabled: true })
      await window.whomi.settings.selectModel('conversation', saved.id)
      await window.whomi.settings.selectModel('analysis', saved.id)
      return saved
    })
    const resized = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1080, 700)
      return window.getNormalBounds()
    })
    await application.close()
    application = await launch()
    page = await application.firstWindow()
    await page.locator('.hello-cover').waitFor({ state: 'attached' })
    await expect(page.locator('.startup-intro')).toHaveCount(0, { timeout: 10000 })
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds())).toEqual(resized)
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('button', { name: '界面验证 · 虚构会话', exact: true }).click()
    const model = page.getByRole('combobox', { name: '对话模型' })
    await expect(model).toHaveValue(configuredModel.id)
    expect(await model.evaluate(element => getComputedStyle(element).appearance)).toBe('base-select')
    await model.click()
    await page.screenshot({ path: join(evidence, 'model-menu.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '会话分析', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认分析' })).toBeEnabled()
    await expect(page.getByText('根据当前会话的全部聊天内容，生成一份分析报告。')).toBeVisible()
    await page.screenshot({ path: join(evidence, 'analysis-confirmation.png') })
  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
