import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('capture comprehensive evidence for import flow, unified top bar, conversation management, and message bubbles', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
  const version = JSON.parse(await readFile('package.json', 'utf8')).version
  const evidence = resolve(`release/validation-${version}`)
  await mkdir(evidence, { recursive: true })

  const sampleData = {
    chatlab: { version: '0.0.2' },
    meta: { name: '界面验收 · 气泡与会话管理', platform: 'discord', type: 'direct', groupId: 'acceptance-group', ownerId: 'user-a' },
    members: [
      { platformId: 'user-a', accountName: '小林' },
      { platformId: 'user-b', accountName: '对方' }
    ],
    messages: [
      { sender: 'user-a', accountName: '小林', timestamp: 1700000000, type: 0, content: '是滴', platformMessageId: 'm1' },
      { sender: 'user-b', accountName: '对方', timestamp: 1700000010, type: 0, content: '好的，收到你的回复了，我们明天继续讨论具体方案。', platformMessageId: 'm2' },
      { sender: 'user-a', accountName: '小林', timestamp: 1700000020, type: 0, content: '明天晚上九点我听你讲，没问题。', platformMessageId: 'm3' }
    ]
  }

  const sampleFile = join(directory, 'chat-sample.json')
  await writeFile(sampleFile, JSON.stringify(sampleData, null, 2))
  const otherFile = join(directory, 'another-sample.json')
  await writeFile(otherFile, JSON.stringify({ ...sampleData, meta: { ...sampleData.meta, groupId: 'other-example' } }))

  const launch = () => electron.launch({
    ...(process.env.WHOMI_PACKAGED_EXECUTABLE
      ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
      : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
    env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  })

  let application
  try {
    application = await launch()
    application.process().stderr.on('data', data => console.log('ELECTRON STDERR:', data.toString()))
    application.process().stdout.on('data', data => console.log('ELECTRON STDOUT:', data.toString()))
    let page = await application.firstWindow()
    page.on('console', msg => console.log('PAGE LOG:', msg.type(), msg.text()))
    page.on('pageerror', err => console.log('PAGE ERROR:', err))
    await page.locator('.hello-cover').waitFor({ state: 'attached' })
    await expect(page.locator('.startup-intro')).toHaveCount(0, { timeout: 15000 })

    // 1. 验证统一顶部品牌区（正常窗口）
    await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
    expect(await page.locator('.sidebar-header').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('drag')
    expect(await page.locator('.brand-link').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
    expect(await page.locator('.header-toggle').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
    await page.screenshot({ path: join(evidence, '01-unified-top-normal.png') })

    // 2. 验证统一顶部品牌区（侧栏收起状态）
    await page.getByRole('button', { name: '收起侧栏' }).click()
    expect(await page.locator('.brand-expand').evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
    await page.screenshot({ path: join(evidence, '02-unified-top-collapsed.png') })

    // 恢复侧栏展开
    await page.getByRole('button', { name: '展开侧栏' }).click()

    // 3. 验证窄窗口布局（574px）
    const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(574, 800)
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(evidence, '03-unified-top-narrow.png') })
    await application.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setSize(bounds.width, bounds.height)
    }, originalBounds)
    await page.waitForTimeout(300)

    // 4. 进入导入流程：验证初始单一连续操作区域
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    const chooseButton = page.getByRole('button', { name: '选择文件', exact: true })
    await expect(chooseButton).toBeVisible()
    await expect(page.getByRole('button', { name: '选择文件夹', exact: true })).toBeVisible()
    await expect(page.getByText('或将文件、文件夹拖到这里')).toBeVisible()
    expect(await page.locator('.import-step').count()).toBe(0)
    await page.screenshot({ path: join(evidence, '04-import-initial-continuous.png') })

    // 5. 拖入聊天文件，进入发现入口阶段
    const box = await chooseButton.boundingBox()
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files: [sampleFile, otherFile], dragOperationsMask: 1 }
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, data }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point })
    await cdp.detach()

    const discovery = page.getByRole('region', { name: '发现的文件入口' })
    await expect(discovery).toBeVisible()
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toHaveCount(0)
    await expect(discovery.getByRole('button', { name: '解析所选入口' })).toBeVisible()
    await expect(discovery.getByRole('button', { name: '取消导入' })).toBeVisible()
    await discovery.getByRole('checkbox').first().check()
    await page.screenshot({ path: join(evidence, '05-import-discovery.png') })

    // 测试未保存前取消：恢复初始选择区域
    await discovery.getByRole('button', { name: '取消导入' }).click()
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, '08-import-cancel-restore.png') })

    // 重新拖入完成解析与确认
    const box2 = await page.getByRole('button', { name: '选择文件', exact: true }).boundingBox()
    const cdp2 = await page.context().newCDPSession(page)
    const point2 = { x: box2.x + box2.width / 2, y: box2.y + box2.height / 2, data: { ...data, files: [sampleFile] } }
    await cdp2.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point2 })
    await cdp2.send('Input.dispatchDragEvent', { type: 'drop', ...point2 })
    await cdp2.detach()

    // 单文件自动解析并保存，不经过目标选择、身份填写或消息预览。
    const results = page.getByRole('region', { name: '导入进度与结果' })
    await expect(results).toBeVisible()
    await expect(page.getByText('导入完成。', { exact: true })).toBeVisible()
    await expect(page.getByText('已保存 3 条消息。', { exact: true })).toBeVisible()
    await expect(page.getByLabel('导入目标', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '预览消息', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '继续导入', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '打开会话', exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, '07-import-completed.png') })

    // 8. 打开会话，检查顶栏对齐与短消息气泡（F10、F13）
    await page.getByRole('button', { name: '打开会话', exact: true }).click()
    await expect(page.locator('#conversation-title')).toBeVisible()

    // 检查短消息“是滴”的气泡宽度（按内容收缩，不被姓名/时间撑宽）
    const shortBubble = page.locator('.message-text', { hasText: '是滴' })
    await expect(shortBubble).toBeVisible()
    const shortBubbleBox = await shortBubble.boundingBox()
    expect(shortBubbleBox.width).toBeLessThan(120)

    // 检查顶栏对齐：操作区与正文右边距对齐（F10）
    const readerHeader = page.locator('.reader-header')
    const readerActions = page.locator('.reader-actions')
    const headerBox = await readerHeader.boundingBox()
    const actionsBox = await readerActions.boundingBox()
    // 验证 actions 靠右对齐（右边距在 24px 左右，消除 164px 空洞）
    const rightMargin = (headerBox.x + headerBox.width) - (actionsBox.x + actionsBox.width)
    expect(rightMargin).toBeLessThan(40)
    // 验证 actions 垂直位置在系统按钮 36px 之下
    expect(actionsBox.y).toBeGreaterThanOrEqual(36)

    await page.screenshot({ path: join(evidence, '10-conversation-header-and-bubbles.png') })

    // 9. 验证更多操作菜单（F11）
    const moreButton = page.getByRole('button', { name: '更多操作', exact: true })
    await expect(moreButton).toBeVisible()
    await moreButton.click()
    await expect(page.getByRole('menuitem', { name: '选择本人' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '删除会话' })).toBeVisible()
    await page.screenshot({ path: join(evidence, '11-conversation-more-menu.png') })

    // 10. 验证“选择本人”对话框
    await page.getByRole('menuitem', { name: '选择本人' }).click()
    const selfModal = page.getByRole('dialog', { name: '选择本人' })
    await expect(selfModal).toBeVisible()
    await expect(selfModal.getByText('小林')).toBeVisible()
    await expect(selfModal.getByText('对方')).toBeVisible()
    await page.screenshot({ path: join(evidence, '12-conversation-select-self-modal.png') })

    // 选择小林并确认设为本人
    await selfModal.locator('label', { hasText: '小林' }).click()
    await selfModal.getByRole('button', { name: '设为本人' }).click()
    await expect(selfModal).toHaveCount(0)

    // 验证气泡更新：小林的消息变为 message-self（靠右展示）
    await expect(page.locator('.message.message-self')).toHaveCount(2)
    const selfBubble = page.locator('.message.message-self .message-text', { hasText: '是滴' })
    const selfBox = await selfBubble.boundingBox()
    // 靠右气泡的 x 坐标明显靠右
    expect(selfBox.x).toBeGreaterThan(headerBox.x + headerBox.width / 2)
    await page.screenshot({ path: join(evidence, '13-conversation-self-bubbles-right.png') })

    // 11. 验证“删除会话”二次确认对话框
    await moreButton.click()
    await page.getByRole('menuitem', { name: '删除会话' }).click()
    const deleteModal = page.getByRole('dialog', { name: '删除会话' })
    await expect(deleteModal).toBeVisible()
    await expect(deleteModal.getByText('将彻底删除该会话及其全部聊天记录、成员、本人设置、对话记录与分析报告。此操作无法撤销。')).toBeVisible()
    await page.screenshot({ path: join(evidence, '14-conversation-delete-confirm-modal.png') })

    // 点击确认删除
    await deleteModal.getByRole('button', { name: '确认删除' }).click()
    await expect(deleteModal).toHaveCount(0)

    // 验证删除后返回个人总览，且会话列表中不再存在该会话
    await expect(page.locator('.personal-overview')).toBeVisible()
    const list = await page.evaluate(() => window.whomi.listConversations({}))
    expect(list.items).toHaveLength(0)
    await page.screenshot({ path: join(evidence, '15-after-delete-overview.png') })

  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
