import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

for (const width of [1280, 360]) test(`导入后在 ${width} 像素确认本人，取消可阅读，重进重问，保存后重启不再提示`, async () => {
  test.setTimeout(80000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-identity-'))
  const evidence = resolve('artifacts/identity-entry')
  const source = join(directory, 'weekend.json')
  const title = '虚构 · 周末出行'
  await mkdir(evidence, { recursive: true })
  await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>true')
  await writeFile(source, JSON.stringify({
    chatlab: { version: '0.0.2' }, meta: { name: title, platform: 'discord', type: 'direct', groupId: 'trip', ownerId: 'a' },
    members: [{ platformId: 'a', accountName: '小禾' }, { platformId: 'b', accountName: '小松' }],
    messages: ['周六几点出发？', '十点在车站碰面。'].map((content, i) => ({
      content, sender: i ? 'b' : 'a', accountName: i ? '小松' : '小禾', timestamp: 1761700000 + 60 * i, type: 0, platformMessageId: 'm' + i,
    })),
  }))
  let app, page
  const btn = name => page.getByRole('button', { name, exact: true })
  const dialog = () => page.getByRole('dialog', { name: '选择本人' })
  const shot = file => page.screenshot({ path: join(evidence, width + '-' + file + '.png'), animations: 'disabled' })
  async function launch() {
    app = await electron.launch({
      ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: width === 360 ? 'reduce' : 'no-preference' })
    await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(320, 320); w.setSize(size, 800) }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await expect(page.locator('.hello-cover')).toBeAttached()
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    if (await btn('展开侧栏').isVisible()) await btn('展开侧栏').click()
  }
  try {
    await launch()
    await btn('导入会话').click()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, source)
    await btn('选择文件').click()
    await btn('打开会话').click()
    const prompt = dialog()
    await expect(prompt).toContainText('这段聊天里，哪位是你？')
    await expect(prompt.getByRole('button', { name: '设为本人' })).toBeDisabled()
    await shot('01-prompt')
    await page.evaluate(() => {
      const card = document.querySelector('dialog .reader-modal-card')
      const real = card.animate.bind(card)
      card.animate = (...args) => {
        const animation = real(...args)
        const last = animation.effect.getKeyframes().at(-1)
        const here = card.getBoundingClientRect()
        const menu = document.querySelector('.reader-more-toggle').getBoundingClientRect()
        const delta = new DOMMatrix(last.transform)
        window.__identityFlight = { distance: Math.hypot(
          here.left + here.width / 2 + delta.e - menu.left - menu.width / 2,
          here.top + here.height / 2 + delta.f - menu.top - menu.height / 2), remaining: last.opacity }
        return animation
      }
    })
    if (width === 1280) await page.keyboard.press('Escape')
    else await prompt.getByRole('button', { name: '取消' }).click()
    await expect(prompt).toHaveCount(0)
    await expect(btn('更多操作')).toBeFocused()
    await expect(page.getByText('可在这里选择本人')).toBeVisible()
    const animation = await page.evaluate(() => window.__identityFlight)
    if (width === 1280) { expect(animation.distance).toBeLessThan(2); expect(animation.remaining).toBe('0') }
    else expect(animation).toBeUndefined()
    await shot('02-menu-hint')
    const summary = await page.evaluate(async () => (await window.whomi.listConversations({})).items[0])
    const members = () => page.evaluate(id => window.whomi.listMembers(id), summary.id)
    expect((await members()).some(member => member.confirmedSelf)).toBe(false)
    await btn('选择消息').click()
    await expect(prompt).toHaveCount(0)
    await btn('返回导入结果').click()
    await btn('打开会话').click()
    await expect(prompt).toBeVisible()
    await prompt.getByRole('radio', { name: /小松/ }).check()
    await prompt.getByRole('button', { name: '设为本人' }).click()
    await expect(prompt).toHaveCount(0)
    expect((await members()).find(member => member.confirmedSelf)?.displayName).toBe('小松')
    await app.close()
    await launch()
    if (await btn('展开会话列表').isVisible()) await btn('展开会话列表').click()
    await btn(summary.title).click()
    await expect(page.locator('.message-self')).toHaveCount(1)
    await btn('更多操作').click()
    await expect(page.getByRole('menuitem', { name: '选择本人' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog()).toHaveCount(0)
    await shot('03-saved-restart')
  } finally {
    await app?.close()
    if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('whomi-runtime-identity-')) await rm(directory, { recursive: true, force: true })
  }
})
