import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const messages = ['周六一起去公园吗？', '好，上午十点见。', '我会带上水。', '那我来带野餐垫。']
const question = '我们分别准备带什么？'
const evidence = resolve('artifacts/clarity-acceptance')
const fixture = {
  chatlab: { version: '0.0.2' },
  meta: { name: '虚构会话 · 周六野餐', platform: 'discord', type: 'direct', groupId: 'picnic-example' },
  members: [{ platformId: 'a', accountName: '小禾' }, { platformId: 'b', accountName: '小松' }],
  messages: messages.map((content, index) => ({
    content, sender: index % 2 ? 'b' : 'a', accountName: index % 2 ? '小松' : '小禾',
    type: 0, timestamp: 1761700000 + index * 60, platformMessageId: String(index + 1),
  })),
}

for (const width of [1280, 360]) test(`在 ${width} 像素窗口逐组管理待发送引用，保留输入中的问题`, async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-composer-'))
  const source = join(directory, 'picnic.json')
  const narrow = width === 360
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(source, JSON.stringify(fixture))
    await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => () => true')
    app = await electron.launch({
      args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(320, 320)
      window.setSize(size, 800)
    }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    const button = name => page.getByRole('button', { name, exact: true })
    const panel = page.getByRole('complementary', { name: 'AI 对话' })
    const editor = page.getByRole('textbox', { name: '向 AI 提问' })
    const preview = page.getByRole('region', { name: '引用预览' })
    const toggle = button('选择消息')
    const option = index => page.getByRole('option', { name: fixture.messages[index].accountName + '：' + messages[index], exact: true })
    const shot = name => page.screenshot({ path: join(evidence, `composer-${width}-${name}.png`), animations: 'disabled' })
    const openPanel = async () => {
      if (!await panel.isVisible()) await button('AI 对话').click()
      await expect(editor).toBeInViewport()
    }
    const showSource = async () => {
      if (narrow && await panel.isVisible()) await button('关闭 AI 对话').click()
      await expect(page.getByRole('region', { name: '聊天记录' })).toBeInViewport()
    }
    const checkMarked = async (selector, expected) => {
      await expect(page.locator(selector).locator('.message-text')).toHaveText(expected.map(index => messages[index]))
    }

    await expect(page.locator('.hello-cover')).toBeAttached()
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    if (await button('展开侧栏').isVisible()) await button('展开侧栏').click()
    await button('导入会话').click()
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source)
    await button('选择文件').click()
    await button('打开会话').click()
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await identity.getByRole('radio', { name: /小松/ }).check()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await expect(identity).toBeHidden()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    for (const index of [0, 1, 3]) await option(index).click()
    await checkMarked('.message-selected', [0, 1, 3])
    await shot('selection-active')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await checkMarked('.message-selected', [0, 1, 3])
    await openPanel()
    await editor.fill(question)
    const entry = button('2 组引用')
    await expect(entry).toBeInViewport()
    expect(await entry.evaluate(node => node.closest('form') === null)).toBe(true)
    const form = editor.locator('xpath=ancestor::form')
    const frame = await form.boundingBox()
    const chip = await entry.boundingBox()
    expect(chip.y + chip.height).toBeLessThanOrEqual(frame.y)

    await button('新建 AI 对话').click()
    await expect(editor).toBeFocused()
    await button('新建 AI 对话').click()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(question)
    await button('显示对话列表').click()
    const history = page.getByRole('navigation', { name: 'AI 对话列表' })
    await expect(history.getByRole('button', { name: '新对话', exact: true })).toHaveCount(1)
    await button('收起对话列表').click()
    await expect(entry).toBeVisible()

    await entry.click()
    await expect(preview.getByRole('button', { name: /引用 1 · 小禾/ })).toContainText('共 2 条消息')
    await expect(preview.getByRole('button', { name: /引用 2 · 小松/ })).toContainText('共 1 条消息')
    await expect(preview).toBeInViewport({ ratio: 1 })
    const rendered = await preview.evaluate(node => {
      const panel = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const controls = [...node.querySelectorAll('button')]
      return {
        rounded: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].every(value => parseFloat(value) > 0),
        clipped: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
        accessible: controls.every(button => {
          const rect = button.getBoundingClientRect()
          return rect.left >= panel.left && rect.right <= panel.right && rect.top >= panel.top && rect.bottom <= panel.bottom &&
            button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }),
      }
    })
    expect(rendered).toEqual({ rounded: true, clipped: false, accessible: true })
    await shot('two-groups')
    await preview.getByRole('button', { name: /引用 1 · 小禾/ }).click()
    await showSource()
    await checkMarked('.message-reference-target', [0, 1, 3])
    await toggle.click()
    await openPanel()
    await entry.click()
    const keep = narrow ? [0, 1] : [3]
    const remove = narrow ? 2 : 1
    await button(`移除第 ${remove} 组引用`).click()
    await expect(preview.getByRole('button', { name: /引用 1 ·/ })).toContainText(messages[keep[0]])
    await expect(preview.getByRole('button', { name: /移除第/ })).toHaveCount(1)
    await expect(button('1 组引用')).toBeVisible()
    await expect(editor).toHaveValue(question)
    await shot('one-group')
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await showSource()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await checkMarked('.message-selected', keep)
    await checkMarked('.message-reference-target', keep)
    await openPanel()
    await button('1 组引用').click()
    await button('移除第 1 组引用').click()
    await expect(preview).toHaveCount(0)
    await expect(button('1 组引用')).toHaveCount(0)
    await expect(button('清空全部引用')).toHaveCount(0)
    await expect(editor).toHaveValue(question)
    await showSource()
    await checkMarked('.message-reference-target', [])
    await checkMarked('.message-selected', [])

    for (const index of [0, 3]) await option(index).click()
    await openPanel()
    await expect(entry).toBeVisible()
    await button('清空全部引用').click()
    await expect(editor).toHaveValue(question)
    await expect(entry).toHaveCount(0)
    await expect(button('清空全部引用')).toHaveCount(0)
    await showSource()
    await checkMarked('.message-selected', [])
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await shot('selection-cleared')
    await toggle.click()
    await openPanel()
    await expect(editor).toHaveValue(question)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await app?.close()
    const target = resolve(directory)
    if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('whomi-runtime-composer-')) {
      await rm(target, { recursive: true, force: true })
    }
  }
})
