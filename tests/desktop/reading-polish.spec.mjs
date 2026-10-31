import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('explicit safe webpage links reach the browser while executable schemes stay blocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>true')
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const page = await application.firstWindow()
    await application.evaluate(({ shell }) => { globalThis.__readingOpenedLinks = []; shell.openExternal = async url => { globalThis.__readingOpenedLinks.push(url) } })
    await page.evaluate(() => window.open('https://example.com/source?q=reading', '_blank'))
    await expect.poll(() => application.evaluate(() => globalThis.__readingOpenedLinks)).toEqual(['https://example.com/source?q=reading'])
    await page.evaluate(() => { for (const url of ['file:///C:/Windows/notepad.exe', 'data:text/html,unsafe', 'https://user:password@example.com/']) window.open(url, '_blank') })
    expect(await application.evaluate(() => globalThis.__readingOpenedLinks)).toEqual(['https://example.com/source?q=reading'])
  } finally {
    await application?.close()
    if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') && directory.includes('whomi-runtime-')) await rm(directory, { recursive: true, force: true })
  }
})

test('reading polish: fixed content, history, model identity, copy, retry and narrow windows', async () => {
  test.setTimeout(180000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  const evidence = resolve('artifacts/reading-polish')
  await mkdir(evidence, { recursive: true })
  const fixture = await readFile(resolve('docs/designs/fixtures/conversation-reading-acceptance.md'), 'utf8')
  const answer = fixture.match(/```markdown\r?\n([\s\S]*?)\r?\n```/)[1].replaceAll('\r\n', '\n')
  let failNext = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const input = JSON.parse(body)
      if (failNext) { failNext = false; response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: '合成连接失败，请重试。', type: 'invalid_request_error' } })); return }
      const last = JSON.stringify(input.messages.at(-1))
      const text = last.includes('滚动检查') ? Array.from({ length: 12 }, () => answer).join('\n\n')
        : last.includes('长内容检查') ? answer + '\n\n| 长内容 | 观察 |\n| --- | --- |\n| ' + '示例长单元格'.repeat(25) + ' | 保留内容 |\n\n```text\n' + 'long_content_'.repeat(100) + '\n```\n\n[长链接](https://example.com/' + 'path'.repeat(60) + ')' : answer
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      let offset = 0
      const timer = setInterval(() => {
        if (response.destroyed) { clearInterval(timer); return }
        const chunk = text.slice(offset, offset + 100); offset += 100
        response.write(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`)
        if (offset >= text.length) {
          clearInterval(timer)
          response.end(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1240, completion_tokens: 286, total_tokens: 1526, prompt_tokens_details: { cached_tokens: 240 } } })}\n\ndata: [DONE]\n\n`)
        }
      }, 70)
      response.on('close', () => clearInterval(timer))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let application
  try {
    await writeFile(join(directory, 'probe.cjs'), `module.exports=(writer)=>async method=>{
      if(method!=='probe.aiSeed')throw Error('Unsupported');
      writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'合成阅读评审','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人'),(2,1,1,'friend','朋友');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
      INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES
      (1,1,2,'member','朋友','text','担心准备不完',0),(2,1,1,'member','本人','text','最卡住的是哪部分？',1),
      (3,1,2,'member','朋友','text','开头一直不顺',2),(4,1,1,'member','本人','text','明晚九点我听你讲，想先听建议还是先说说？',3);\`); return true;
    }`)
    const launch = () => electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    application = await launch()
    let page = await application.firstWindow()
    await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.aiSeed', null))
    const models = await page.evaluate(async baseUrl => {
      const p = await window.whomi.settings.saveProvider({ name: '合成评审服务', baseUrl, enabled: true, apiKey: 'synthetic-test-key' })
      const a = await window.whomi.settings.saveModel({ providerId: p.id, label: '评审模型甲', model: 'model-a', contextWindow: 128000, maxTokens: 8192, enabled: true })
      const b = await window.whomi.settings.saveModel({ providerId: p.id, label: '评审模型乙', model: 'model-b', contextWindow: 128000, maxTokens: 8192, enabled: true })
      await window.whomi.settings.selectModel('conversation', a.id)
      return { a, b }
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await application.close(); application = await launch(); page = await application.firstWindow()
    const resize = async width => {
      await application.evaluate(({ BrowserWindow }, width) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(320, 320); w.setSize(width, 800) }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    }
    const shot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
    const open = async () => {
      await page.getByRole('button', { name: '展开会话列表' }).click()
      await page.getByRole('button', { name: '合成阅读评审', exact: true }).click()
      await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
    }
    await resize(1280); await open()
    const input = page.getByRole('textbox', { name: '向 AI 提问' })
    await expect(page.getByRole('navigation', { name: 'AI 对话列表' })).toHaveCount(0)
    await input.fill('这段示例里，我怎样回应了朋友？')
    await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect(page.getByRole('button', { name: '复制回答' })).toBeVisible({ timeout: 30000 })
    const log = page.getByRole('log')
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4)
    await expect(log.getByRole('heading')).toHaveCount(2)
    await expect(log.getByRole('listitem')).toHaveCount(3)
    await expect(log.getByRole('row')).toHaveCount(3)
    await expect(page.locator('.conversation-answer-label')).toContainText('评审模型甲')
    await log.evaluate(el => { el.scrollTop = 0 })
    await shot('C01-whomi-after-1280x800')
    const widths = await page.evaluate(() => Object.fromEntries(['.conversation-source', '.conversation-ai-panel', '.conversation-thread-content'].map(s => [s, document.querySelector(s).getBoundingClientRect().width])))
    expect(widths['.conversation-thread-content']).toBeGreaterThan(600)
    await page.getByRole('button', { name: '复制回答' }).click()
    expect((await application.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n')).toBe(answer)
    await page.locator('.conversation-usage button').click()
    const stats = page.getByRole('region', { name: '生成统计' })
    await expect(stats).toContainText('评审模型甲')
    await expect(stats).toContainText('1,240 Tokens')
    await expect(stats).toContainText('286 Tokens')
    await expect(stats).toContainText('240 Tokens')
    await expect(stats).toContainText('1,000 Tokens')
    const primarySpeed = await stats.locator('.cherry-usage-primary dd').nth(2).innerText()
    await expect(page.locator('.conversation-usage button')).toContainText(primarySpeed.replace('Token/秒', 'token/秒'))
    expect(await stats.locator('.cherry-usage-primary dd').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight))).toBe(true)
    await shot('C12-whomi-statistics-1280x800'); await page.keyboard.press('Escape')
    await page.getByRole('combobox', { name: '对话模型' }).click()
    await page.getByRole('option', { name: '评审模型乙' }).click()
    await expect(page.locator('.conversation-answer-label')).toContainText('评审模型甲')
    await input.fill('用乙继续观察'); await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect(page.getByRole('button', { name: '复制回答' })).toHaveCount(2)
    await expect(page.locator('.conversation-answer-label').nth(1)).toContainText('评审模型乙')
    const firstThread = (await page.evaluate(() => window.whomi.ai.listThreads('1')))[0]
    await log.evaluate(el => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')) })
    const readingPosition = await log.evaluate(el => el.scrollTop)
    await input.fill('原对话的后续草稿')
    await page.getByRole('button', { name: '选择消息', exact: true }).click()
    await page.getByRole('option', { name: '本人：最卡住的是哪部分？' }).click()
    await page.getByRole('button', { name: '新建 AI 对话' }).click()
    await expect(input).toHaveValue('')
    await input.fill('第二条对话的草稿')
    await page.getByRole('button', { name: '显示对话列表' }).click()
    await shot('C06-whomi-history-1280x800')
    await page.getByRole('navigation').getByRole('button', { name: firstThread.title, exact: true }).click()
    await expect(input).toHaveValue('原对话的后续草稿')
    await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(readingPosition)
    await expect(page.locator('.conversation-composer').getByRole('button', { name: '1 条引用' })).toBeVisible()
    await page.getByRole('button', { name: '清除引用' }).click()
    await page.getByRole('button', { name: '显示对话列表' }).click(); await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '显示对话列表' })).toBeFocused()
    await page.getByRole('button', { name: '显示对话列表' }).click()
    await page.getByRole('button', { name: '关闭对话列表', exact: true }).click()
    await expect(page.getByRole('button', { name: '显示对话列表' })).toBeFocused()
    failNext = true
    await input.fill('合成失败检查'); await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect(page.getByRole('button', { name: '重试回答' })).toBeVisible({ timeout: 30000 })
    await input.fill('失败后的下一条草稿')
    await page.getByRole('button', { name: '重试回答' }).click()
    await expect(page.getByRole('button', { name: '复制回答' })).toHaveCount(3)
    await expect(input).toHaveValue('失败后的下一条草稿')
    await shot('C18-whomi-retry-draft-1280x800')
    await input.fill('滚动检查'); await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1000)
    await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await expect(page.getByRole('button', { name: '停止回答' })).toBeVisible()
    await expect.poll(() => log.getByRole('heading').count()).toBeGreaterThan(10)
    expect(await log.evaluate(el => el.scrollTop)).toBeLessThan(4)
    await log.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
    await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4)
    await input.fill('滚动检查停止'); await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect.poll(() => page.locator('.conversation-turn').last().innerText()).toContain(answer.split('\n')[0])
    await page.getByRole('button', { name: '停止回答' }).click()
    await expect.poll(() => page.evaluate(async id => (await window.whomi.ai.getThread(id)).turns.at(-1).state, firstThread.id)).toBe('stopped')
    const partial = await page.evaluate(async id => (await window.whomi.ai.getThread(id)).turns.at(-1).text, firstThread.id)
    expect(partial.length).toBeGreaterThan(0)
    await page.locator('.conversation-turn').last().getByRole('button', { name: '复制回答' }).click()
    await expect(page.locator('.conversation-turn').last().getByRole('button', { name: '已复制' })).toBeVisible()
    expect((await application.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n')).toBe(partial)
    await page.getByRole('button', { name: '新建 AI 对话' }).click()
    await input.fill('长内容检查'); await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect(page.getByRole('button', { name: '复制回答' })).toHaveCount(1)
    for (const width of [960, 360, 1280]) {
      await resize(width)
      await expect(input).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const overflow = await page.locator('.conversation-answer-text pre').evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, right: el.getBoundingClientRect().right }))
      expect(overflow.scroll).toBeGreaterThan(overflow.width)
      expect(overflow.right).toBeLessThanOrEqual(width)
      await page.getByRole('combobox', { name: '对话模型' }).click()
      await expect(page.getByRole('option', { name: '评审模型乙' })).toBeVisible()
      await shot(`C19-whomi-models-${width}x800`); await page.keyboard.press('Escape')
      await page.locator('.conversation-usage button').first().click(); await expect(stats).toBeVisible()
      const card = await stats.boundingBox(); expect(card.x).toBeGreaterThanOrEqual(0); expect(card.x + card.width).toBeLessThanOrEqual(width)
      expect(await stats.locator('.cherry-usage-primary dd').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth))).toBe(true)
      await shot(`C19-whomi-statistics-${width}x800`); await page.keyboard.press('Escape')
      await input.fill('窄窗保留草稿'); await page.getByRole('button', { name: '关闭 AI 对话' }).click()
      await expect(page.getByRole('button', { name: 'AI 对话', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
      await expect(input).toHaveValue('窄窗保留草稿'); await expect(input).toHaveCount(1)
      await log.evaluate(el => { el.scrollTop = el.scrollHeight }); await shot(`C04-whomi-overflow-${width}x800`)
      if (width === 360) {
        failNext = true
        await input.fill('窄窗失败检查'); await page.getByRole('button', { name: '发送给 AI' }).click()
        await expect(page.getByRole('button', { name: '重试回答' })).toBeVisible({ timeout: 30000 })
        await input.fill('窄窗失败后的下一条草稿'); await shot('C19-whomi-failure-draft-360x800')
        await page.getByRole('button', { name: '重试回答' }).click()
        await expect(page.getByRole('button', { name: '复制回答' })).toHaveCount(2)
        await expect(input).toHaveValue('窄窗失败后的下一条草稿')
        await expect(input).toHaveCount(1)
      }
    }
    await application.evaluate(({ shell }) => { globalThis.__readingOpenedLinks = []; shell.openExternal = async url => { globalThis.__readingOpenedLinks.push(url) } })
    await page.getByRole('link', { name: '长链接' }).click()
    await expect.poll(() => application.evaluate(() => globalThis.__readingOpenedLinks.length)).toBe(1)
    await page.evaluate(() => { for (const url of ['file:///C:/Windows/notepad.exe', 'data:text/html,unsafe', 'https://user:password@example.com/']) window.open(url, '_blank') })
    expect(await application.evaluate(() => globalThis.__readingOpenedLinks.length)).toBe(1)
    await page.evaluate(async model => { await window.whomi.settings.saveModel({ id: model.id, providerId: model.providerId, label: '甲已改名', model: model.model, contextWindow: model.contextWindow, maxTokens: model.maxTokens, enabled: false }) }, models.a)
    await application.close(); application = await launch(); page = await application.firstWindow()
    const restored = await page.evaluate(id => window.whomi.ai.getThread(id), firstThread.id)
    expect(restored.turns[0].modelIdentity).toEqual({ id: models.a.id, version: 1, label: '评审模型甲', model: 'model-a' })
    await resize(1280); await open()
    await page.getByRole('button', { name: '显示对话列表' }).click()
    await page.getByRole('navigation').getByRole('button', { name: firstThread.title, exact: true }).click()
    await expect(page.locator('.conversation-answer-label').first()).toContainText('评审模型甲')
    await page.getByRole('log').evaluate(el => { el.scrollTop = 0 })
    await shot('C11-whomi-restored-1280x800')
    await writeFile(join(evidence, 'environment.json'), JSON.stringify({ synthetic: true, version: '0.1.5 source build', reference: 'Cherry Studio 2.1.8 existing review screenshots', theme: 'light', zoom: await page.evaluate(() => devicePixelRatio), dimensions: [1280, 960, 360], widths, answer, completed: new Date().toISOString() }, null, 2))
  } finally {
    await application?.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') && directory.includes('whomi-runtime-')) await rm(directory, { recursive: true, force: true })
  }
})
