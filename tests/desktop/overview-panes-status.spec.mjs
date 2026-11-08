import { _electron as electron, expect, test } from '@playwright/test'
import { chatEditor } from './chat-helpers.mjs'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { sourceMessages } from './fixtures/moving-chat.mjs'

test('从空总览导入记录，调整三个分栏，在宽窄窗口发送、重试并保留草稿', async () => {
  test.setTimeout(150000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-overview-panes-'))
  const evidence = resolve('release/handoff-validation/overview-panes-status')
  let pending
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { pending = res }) })
  let app, page
  const button = name => page.getByRole('button', { name, exact: true })
  const separator = name => page.getByRole('separator', { name, exact: true })
  const shot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
  const widthOf = selector => page.locator(selector).evaluate(el => Math.round(el.getBoundingClientRect().width))
  const resize = async width => {
    await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320,320); win.setSize(w,800) }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  }
  async function launch() {
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await resize(1280)
  }
  async function drag(name, selector, delta, direction = 1) {
    const handle = separator(name)
    await handle.click({ trial: true })
    const width = await widthOf(selector)
    const box = await handle.boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x,y)
    await page.mouse.down()
    await page.mouse.move(x + delta,y,{ steps: 12 })
    await page.mouse.up()
    await expect.poll(() => widthOf(selector), { message: name + '，拖动前 ' + width }).toBe(Math.round(width + delta * direction))
    return { name, selector, before: width, after: await widthOf(selector) }
  }
  async function reset(pane) {
    await expect.poll(() => widthOf(pane.selector)).toBe(pane.after)
    await separator(pane.name).dblclick()
    await expect.poll(async () => Math.abs(await widthOf(pane.selector) - pane.before)).toBeLessThanOrEqual(1)
  }
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    await mkdir(evidence, { recursive: true })
    const source = join(directory, 'moving-chat.json')
    await writeFile(source, JSON.stringify({
      chatlab: { version: '0.0.2' }, meta: { name: '和小林搬家', platform: 'discord', type: 'direct', groupId: 'move-house', ownerId: 'a' },
      members: [{ platformId: 'a', accountName: '本人' }, { platformId: 'b', accountName: '小林' }],
      messages: sourceMessages.map((content, i) => ({ content, sender: i % 2 ? 'b' : 'a', accountName: i % 2 ? '小林' : '本人',
        timestamp: 1761700000 + i * 60, type: 0, platformMessageId: 'm' + (i+1) })),
    }))
    await launch()
    await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '本机验收服务', baseUrl, enabled: true, apiKey: 'test-only' })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '搬家示例模型', model: 'local-fixture', enabled: true, contextWindow: 64000, maxTokens: 512 })
      await window.whomi.settings.selectModel('conversation', model.id)
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await button('个人总览').click()
    await expect(button('导入聊天记录')).toBeInViewport()
    await shot('01-empty-wide')
    await button('导入聊天记录').click()
    await expect(button('选择文件')).toBeInViewport()
    await resize(360)
    await button('个人总览').click()
    await shot('02-empty-narrow')
    await button('导入聊天记录').click()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, source)
    await button('选择文件').click()
    await expect(page.getByText('已保存 24 条消息。', { exact: true })).toBeVisible()
    await button('个人总览').click()
    await shot('03-records-narrow')
    await button('打开会话整理').click()
    const identity = page.getByRole('dialog', {name:'选择本人'})
    await identity.getByRole('radio', {name:/本人/}).check()
    await identity.getByRole('button', {name:'设为本人'}).click()
    await expect(identity).toBeHidden()
    await expect(page.getByText(sourceMessages[0], { exact: true })).toBeVisible()
    await app.close()
    await launch()
    await button('个人总览').click()
    await expect(button('打开会话整理')).toBeVisible()
    await shot('04-records-wide')
    await button('打开会话整理').click()
    const nav = await drag('调整主导航宽度', '.sidebar', 55)
    await button('AI 对话').click()
    const assistant = await drag('调整原文与对话宽度', '.conversation-ai-panel', 76, -1)
    await expect(button('选择消息')).toBeInViewport()
    await expect(button('关闭 AI 对话')).toBeInViewport()
    await shot('05-two-panes-resized')
    await button('设置').click()
    const providers = await drag('调整服务商列表宽度', '.ms-provider-list', 60)
    await expect(page.getByLabel('搜索服务商', { exact: true })).toBeInViewport()
    await expect(page.getByLabel('接口地址', { exact: true })).toBeInViewport()
    await shot('06-providers-resized')
    await app.close()
    await launch()
    await expect.poll(() => widthOf(nav.selector)).toBe(nav.after)
    await button('设置').click()
    await reset(providers)
    await resize(360)
    await expect(separator(providers.name)).toBeHidden()
    await button('本机验收服务').click()
    await expect(button('返回服务商')).toBeInViewport()
    await expect(page.getByLabel('搜索服务商', { exact: true })).toBeHidden()
    await shot('07-provider-detail-narrow')
    await button('返回服务商').click()
    await expect(page.getByLabel('搜索服务商', { exact: true })).toBeInViewport()
    await noOverflow()
    await resize(1280)
    await button('返回').click()
    await button('个人总览').click()
    await button('打开会话整理').click()
    await button('AI 对话').click()
    await reset(assistant)
    await reset(nav)
    for (const width of [1280,360]) {
      await resize(width)
      if (width === 360) {
        await expect(separator(nav.name)).toBeHidden()
        await expect(separator(assistant.name)).toBeHidden()
        await expect(page.locator('.conversation-source')).toHaveAttribute('inert','')
        await expect.poll(() => page.locator('.brand-symbol img').evaluate(el => el.naturalWidth)).toBeGreaterThan(0)
      }
      const draft = chatEditor(page)
      const question = '回顾搬家安排 · ' + width
      await draft.fill(question)
      await button('发送给 AI').click()
      const log = page.getByRole('log', { name: 'AI 对话记录' })
      const sent = log.locator('[data-message-id$=":user"]')
        .filter({ has: page.getByText(question, { exact: true }) })
      const sentId = await sent.getAttribute('data-message-id')
      const turn = log.locator(`[data-message-id="${sentId.replace(/:user$/, ':assistant')}"] .message-assistant`)
      const waiting = turn.getByRole('status').getByText('正在回答…', { exact: true })
      await expect(waiting).toBeInViewport()
      const avatar = await turn.locator('.message-avatar svg').boundingBox()
      const model = await turn.getByText('搬家示例模型', { exact: true }).boundingBox()
      const label = await waiting.boundingBox()
      expect(avatar.x + avatar.width).toBeLessThanOrEqual(label.x)
      expect(Math.abs(model.x - label.x)).toBeLessThanOrEqual(1)
      expect(label.y).toBeGreaterThanOrEqual(model.y + model.height)
      await shot('08-waiting-' + width)
      await expect.poll(() => !!pending, { timeout: 30000 }).toBe(true)
      pending.writeHead(400, { 'Content-Type': 'application/json' })
      pending.end(JSON.stringify({ error: { message: '虚构请求失败，请重试。', type: 'invalid_request_error' } }))
      pending = undefined
      await expect(turn.getByRole('button', { name: '重试回答' })).toBeInViewport()
      await draft.fill('下一条草稿 · ' + width)
      await shot('09-failed-' + width)
      await turn.getByRole('button', { name: '重试回答' }).click()
      await expect(waiting).toBeVisible()
      await expect.poll(() => !!pending, { timeout: 30000 }).toBe(true)
      const chunk = { id: 'fixture', choices: [{ index: 0, delta: { content: '你们约定周六搬家。' }, finish_reason: null }] }
      pending.writeHead(200, { 'Content-Type': 'text/event-stream' })
      pending.write('data: ' + JSON.stringify(chunk) + '\n\n')
      await expect(turn.getByText('你们约定周六搬家。', { exact: true })).toBeVisible()
      await expect(waiting).toHaveCount(0)
      await expect(button('停止回答')).toBeVisible()
      await shot('10-streaming-' + width)
      pending.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8 } }) + '\n\ndata: [DONE]\n\n')
      pending = undefined
      await expect(turn.getByRole('button', { name: '复制回答' })).toBeVisible()
      await expect(draft).toHaveText('下一条草稿 · ' + width)
      await noOverflow()
    }
    await button('关闭 AI 对话').click()
    await expect(page.getByText(sourceMessages[0], { exact: true })).toBeInViewport()
  } finally {
    server.closeAllConnections()
    await app?.close()
    await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
