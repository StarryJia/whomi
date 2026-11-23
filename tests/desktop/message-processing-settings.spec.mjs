import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('消息处理在正常和最小窗口中居中显示秒数，说明及输入错误可就近阅读', async ({}, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'whomi-runtime-processing-settings-'))
  await writeFile(join(profile, 'probe.cjs'), 'module.exports=()=>async()=>true')
  const app = await electron.launch({
    args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
    env: { ...process.env, WHOMI_RUNTIME_TEST: profile },
  })
  const page = await app.firstWindow()
  const button = (name) => page.getByRole('button', { name, exact: true })
  const number = page.getByRole('spinbutton', { name: '合并时间窗口', exact: true })
  const tooltip = page.getByRole('tooltip')
  const screenshot = name => page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' })
  async function expectReadableHelp() {
    await expect(tooltip).toBeVisible()
    const visible = page.locator('.setting-help-content')
    // Radix 的辅助文本宽度为一像素，遮挡和裁切要检查实际绘制的浮层。
    await expect(visible).toBeInViewport({ ratio: 1 })
    expect(await visible.evaluate(element => {
      const { left, right, top, bottom } = element.getBoundingClientRect()
      return [left + 6, right - 6].every(x => [top + 6, bottom - 6].every(y =>
        element.contains(document.elementFromPoint(x, y))))
    })).toBe(true)
  }
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await button('设置').click()
    await button('消息处理').click()
    await expect(number).toHaveValue('180')
    for (const size of ['normal', 'minimum']) {
      const viewport = await app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (size === 'minimum') win.setSize(...win.getMinimumSize())
        return win.getContentSize()
      }, size)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(viewport)
      await number.evaluate(element => element.scrollIntoView({ block: 'center' }))
      for (const value of ['1', '60', '600', '180']) {
        await number.fill(value)
        await number.press('Enter')
        await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).processing.mergeSeconds)).toBe(Number(value))
        const minus = await button('减少合并时间窗口 1 秒').boundingBox()
        const plus = await button('增加合并时间窗口 1 秒').boundingBox()
        const textCenter = await number.evaluate(input => {
          const rect = input.getBoundingClientRect()
          const style = getComputedStyle(input)
          const left = rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
          const right = rect.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
          return { alignment: style.textAlign, x: (left + right) / 2 }
        })
        expect(textCenter.alignment).toBe('center')
        expect(Math.abs(textCenter.x - (minus.x + minus.width + plus.x) / 2)).toBeLessThanOrEqual(1)
        if (value === '180') await screenshot(size + '-centered')
      }
      const mergeHelp = button('合并连续发言说明')
      await mergeHelp.hover()
      await expect(tooltip).toHaveText('将同一人连续发送的文字合并后交给模型，减少重复的昵称和时间。查看原始聊天时，每条消息仍单独显示。')
      await expectReadableHelp()
      await screenshot(size + '-merge-help')
      await number.hover()
      await expect(tooltip).toHaveCount(0)
      await mergeHelp.hover()
      await expect(tooltip).toBeVisible()
      await page.mouse.move(1, 1)
      await expect(tooltip).toHaveCount(0)
      await number.fill('601')
      await number.press('Tab')
      await expect(page.getByRole('alert')).toHaveText('请输入 1～600 的整数秒数。')
      expect(await page.evaluate(async () => (await window.whomi.settings.get()).processing.mergeSeconds)).toBe(180)
      await number.focus()
      await screenshot(size + '-invalid')
      await number.fill('180')
      await number.press('Tab')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await button('恢复默认规则').click()
      const dialog = page.getByRole('dialog', { name: '恢复默认规则' })
      const help = dialog.getByRole('button', { name: '恢复默认规则说明' })
      await help.focus()
      await expectReadableHelp()
      await screenshot(size + '-dialog-focus')
      await page.keyboard.press('Escape')
      await expect(tooltip).toHaveCount(0)
      await expect(help).toBeFocused()
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toHaveCount(0)
    }
  } catch (error) {
    await screenshot('failure').catch(() => {})
    throw error
  } finally {
    await app.close()
  }
})
