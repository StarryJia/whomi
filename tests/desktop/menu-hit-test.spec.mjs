import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('conversation menu accepts pointer selection outside its draggable header', async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-menu-hit-'))
  const evidence = resolve('release/menu-hit-test-20261031')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(directory, 'probe.cjs'), `module.exports=writer=>method=>{
    if(method==='probe.failSelf'){writer.exec("CREATE TRIGGER reject_self BEFORE INSERT ON self_confirmations BEGIN SELECT RAISE(ABORT,'example save failure'); END");return true;}
    if(method==='probe.allowSelf'){writer.exec('DROP TRIGGER reject_self');return true;}
    if(method!=='probe.seed')throw Error('Unsupported');
    writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'菜单命中 · 虚构会话','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','menu-hit');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'example-self','示例甲'),(2,1,1,'example-peer','示例乙');
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','示例甲','text','菜单命中测试使用的合成消息。',0);\`);return true;
  }`)
  const app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await page.locator('.hello-cover').waitFor({ state: 'attached' })
    await expect(page.locator('.startup-intro')).toHaveCount(0, { timeout: 15000 })
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.seed', null))
    await page.reload()
    await page.locator('.hello-cover').waitFor({ state: 'attached' })
    await expect(page.locator('.startup-intro')).toHaveCount(0, { timeout: 15000 })
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('button', { name: '菜单命中 · 虚构会话', exact: true }).click()
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    const self = page.getByRole('menuitem', { name: '选择本人', exact: true })
    await self.waitFor()
    await page.screenshot({ path: join(evidence, '01-menu-before.png') })
    for (const { width, height, zoom } of [
      { width: 1200, height: 800, zoom: 1 },
      { width: 960, height: 720, zoom: 1.25 },
      { width: 360, height: 800, zoom: 1 },
    ]) {
      await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(320, 320)
        window.setSize(width, height)
        window.webContents.setZoomFactor(zoom)
      }, { width, height, zoom })
      for (const offset of [2, 18, 33]) {
        if (!await self.isVisible()) await page.getByRole('button', { name: '更多操作', exact: true }).click()
        const hit = await self.evaluate((element, offset) => {
          const bounds = element.getBoundingClientRect()
          const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + offset)
          return { hit: element === hit || element.contains(hit), appRegion: getComputedStyle(element).getPropertyValue('app-region') }
        }, offset)
        expect(hit).toEqual({ hit: true, appRegion: 'no-drag' })
        await self.click({ position: { x: 65, y: offset }, timeout: 4000 })
        await expect(page.getByRole('dialog', { name: '选择本人' })).toBeVisible({ timeout: 4000 })
        if (offset === 18) await page.keyboard.press('Escape')
        else await page.getByRole('button', { name: '取消', exact: true }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '更多操作', exact: true })).toBeFocused()
      }
    }
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await self.click()
    await page.screenshot({ path: join(evidence, '02-narrow-self-dialog.png') })
    await page.getByRole('radio', { name: '示例乙' }).check()
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.failSelf', null))
    await page.getByRole('button', { name: '设为本人', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '选择本人' }).getByRole('alert')).toBeVisible()
    await expect(page.getByRole('radio', { name: '示例乙' })).toBeChecked()
    await page.screenshot({ path: join(evidence, '03-narrow-save-failed.png') })
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.allowSelf', null))
    await page.getByRole('button', { name: '设为本人', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.whomi.listMembers('1')).find(member => member.confirmedSelf)?.displayName)).toBe('示例乙')
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '更多操作', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '删除会话' })).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '更多操作', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '选择消息', exact: true }).click()
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await self.click()
    await page.getByRole('button', { name: '取消', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '退出选择', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } finally { await app.close() }
})
