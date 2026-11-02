import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { sourceMessages, selectedNumbers } from './fixtures/moving-chat.mjs'

test('核对同一问题的19条原文，跨页、失败重试和重启后保持整组', async () => {
  test.setTimeout(150000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-references-'))
  const evidence = resolve('release/handoff-validation/references')
  const title = '和小林搬家 · 虚构会话'
  // 第 16、17 条之间插入分页填充，使一次定位取到的前后文不足以包含整组。
  const id = n => 85 + n + (n > 16 ? 100 : 0)
  const ids = selectedNumbers.map(n => String(id(n)))
  const texts = Array.from({ length: 710 }, (_, i) => `分页填充 ${i + 1}`)
  sourceMessages.forEach((message, index) => { texts[id(index + 1) - 1] = message })
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const first = { id: 'fixture', choices: [{ index: 0, delta: { content: '你们确认了周六的时间，一起安排了搬家。' }, finish_reason: null }] }
      const last = { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 20 } }
      res.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)
    })
  })
  let app, page
  async function launch(width) {
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 320); win.setSize(w, 800) }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  }
  const shot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
  const probe = name => app.evaluate((_, name) => globalThis.__whomiRuntimeProbe.request(name, null), name)
  const button = name => page.getByRole('button', { name, exact: true })
  const highlighted = () => page.locator('.message-reference-target').evaluateAll(nodes => nodes.map(el => el.dataset.messageId))
  async function open() {
    if (await button('展开侧栏').isVisible()) await button('展开侧栏').click()
    await button('展开会话列表').click()
    await button(title).click()
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => method => {
      if (method === 'probe.hide') { writer.prepare('UPDATE messages SET id=9999 WHERE id=?').run(${id(1)}); return true }
      if (method === 'probe.restore') { writer.prepare('UPDATE messages SET id=? WHERE id=9999').run(${id(1)}); return true }
      if (method !== 'probe.seed') throw Error('Unknown probe')
      writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'${title}','direct',0);" +
        "INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');" +
        "INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人'),(2,1,1,'friend','小林');" +
        "INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');")
      const insert = writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(?,1,?,'member',?,'text',?,?,?)")
      writer.transaction(() => ${JSON.stringify(texts)}.forEach((text,i) => {
        const mine = i % 2 === 1
        insert.run(i+1, mine ? 1 : 2, mine ? '本人' : '小林', text, i, 1761700000000+i*60000)
      }))()
      writer.prepare("INSERT INTO conversation_summaries(conversation_id,message_count,member_count,status) VALUES(1,?,2,'ready')").run(${texts.length})
      return true
    }`)
    await launch(1280)
    await probe('probe.seed')
    await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '本机验收服务', baseUrl, enabled: true, apiKey: 'test-only' })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '搬家示例模型', model: 'local-fixture', enabled: true, contextWindow: 64000, maxTokens: 512 })
      await window.whomi.settings.selectModel('conversation', model.id)
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await app.close()
    await launch(1280)
    await open()
    await button('选择消息').click()
    await button('加载后文').click()
    await button('加载后文').click()
    for (const n of selectedNumbers) await page.getByRole('option', { name: `${n % 2 ? '本人' : '小林'}：${sourceMessages[n - 1]}`, exact: true }).click()
    await button('完成选择').click()
    await button('AI 对话').click()
    const draft = page.getByRole('textbox', { name: '向 AI 提问' })
    await draft.fill('帮我回顾这次搬家。')
    await button('发送给 AI').click()
    await expect(page.getByRole('log')).toContainText('一起安排了搬家', { timeout: 30000 })
    await draft.fill('还想问小猫的事')
    for (let i = 0; i < 4; i++) await button('加载后文').click()
    const first = page.locator(`[data-message-id="${id(1)}"]`)
    await expect(first).toHaveCount(0)
    await probe('probe.hide')
    await button('19 条引用').click()
    await expect(button('重试定位')).toBeVisible()
    await expect(draft).toHaveValue('还想问小猫的事')
    await shot('01-wide-retry')
    await probe('probe.restore')
    await button('重试定位').click()
    await expect(first).toBeFocused()
    await expect(first).toBeInViewport()
    await expect.poll(highlighted).toEqual(selectedNumbers.filter(n => n <= 16).map(n => String(id(n))))
    await shot('02-wide-referenced-and-skipped')
    await button('加载后文').click()
    await expect.poll(highlighted).toEqual(ids)
    await page.locator(`[data-message-id="${id(22)}"]`).scrollIntoViewIfNeeded()
    await shot('03-wide-next-page')
    await app.close()
    await launch(360)
    await open()
    await button('AI 对话').click()
    await expect(button('19 条引用')).toBeInViewport()
    await shot('04-narrow-restored-turn')
    await button('19 条引用').click()
    await expect(page.getByRole('complementary', { name: 'AI 对话' })).toHaveCount(0)
    const restoredFirst = page.locator(`[data-message-id="${id(1)}"]`)
    await expect(restoredFirst).toBeFocused()
    await expect(restoredFirst).toBeInViewport({ ratio: 1 })
    await expect(page.getByText(sourceMessages[2], { exact: true })).toBeInViewport({ ratio: 1 })
    await shot('05-narrow-referenced-and-skipped')
    await button('加载后文').click()
    await button('加载后文').click()
    await expect.poll(highlighted).toEqual(ids)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
