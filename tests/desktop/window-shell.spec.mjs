import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { windowsMouse } from './fixtures/windows-mouse.mjs'

test('desktop shell preserves bounds and the right conversation strip moves the native window', async ({}, info) => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  const version = JSON.parse(await readFile('package.json', 'utf8')).version
  const evidence = info.outputPath('screenshots')
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
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'AI 对话' })
    const panelBounds = () => panel.boundingBox()
    const windowBounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    if (process.platform === 'win32') {
      await expect(panel).toBeVisible()
      await expect.poll(async () => (await panelBounds()).width).toBeGreaterThan(300)
      const snapshots = []
      const dragStrip = async (label, ratio, dx) => {
        const before = await windowBounds()
        const { x: left } = await panelBounds()
        const x = left + 7 + (before.width - 140 - left - 14) * ratio
        await windowsMouse(application, x, 18, x + dx, 18)
        await expect.poll(async () => {
          const after = await windowBounds()
          snapshots.push({ label, before, after })
          await writeFile(info.outputPath('window-coordinates.json'), JSON.stringify(snapshots, null, 2))
          return after.x
        }, { timeout: 1800 }).not.toBe(before.x)
      }
      await page.screenshot({ path: join(evidence, 'open-ai-panel.png'), animations: 'disabled' })
      await dragStrip('left', 0, 34)
      await dragStrip('center', 0.5, -34)
      await dragStrip('right', 1, 34)
      await panel.getByRole('button', { name: '显示对话列表' }).click()
      await expect(page.getByRole('navigation', { name: 'AI 对话列表' })).toBeVisible()
      await panel.getByRole('button', { name: '新建 AI 对话' }).click()
      await expect.poll(async () => (await page.evaluate(() => window.whomi.ai.listThreads('1'))).length).toBe(1)
      const divider = page.getByRole('separator', { name: '调整原文与对话宽度' })
      const { x, y, width, height } = await divider.boundingBox()
      const windowBeforeDivider = await windowBounds()
      const panelBeforeDivider = await panelBounds()
      await windowsMouse(application, x + width / 2, y + height / 2, x + width / 2 + 52, y + height / 2)
      await expect.poll(async () => (await panelBounds()).width).toBeLessThan(panelBeforeDivider.width)
      expect(await windowBounds()).toEqual(windowBeforeDivider)
      await panel.getByRole('button', { name: '关闭 AI 对话' }).click()
      await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
      await expect(panel).toBeVisible()
      await dragStrip('reopened', 0.5, -34)
      await page.screenshot({ path: join(evidence, 'dragged-and-reopened.png'), animations: 'disabled' })
      const state = () => application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return { maximized: window.isMaximized(), minimized: window.isMinimized() }
      })
      const caption = async offset => windowsMouse(application, (await windowBounds()).width - offset, 18)
      await caption(68)
      await expect.poll(state).toEqual({ maximized: true, minimized: false })
      await caption(68)
      await expect.poll(state).toEqual({ maximized: false, minimized: false })
      await caption(116)
      await expect.poll(state).toEqual({ maximized: false, minimized: true })
      await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.focus() })
      await expect.poll(state).toEqual({ maximized: false, minimized: false })
    }
    const model = page.getByRole('combobox', { name: '对话模型' })
    await expect(model).toContainText(configuredModel.label)
    expect(await model.evaluate(element => element.tagName)).toBe('BUTTON')
    await model.click()
    await page.screenshot({ path: join(evidence, 'model-menu.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '关闭 AI 对话' }).click()
    await page.getByRole('button', { name: '会话洞察', exact: true }).click()
    await expect(page.getByRole('button', { name: '开始洞察' })).toBeEnabled()
    await page.screenshot({ path: join(evidence, 'analysis-confirmation.png') })
    if (process.platform === 'win32') {
      await page.getByRole('button', { name: '取消', exact: true }).click()
      const beforeClose = await windowBounds()
      const closed = page.waitForEvent('close')
      await windowsMouse(application, beforeClose.width - 22, 18)
      await closed
    }
  } catch (error) {
    await application?.windows()[0]?.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
