import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function observeRuntime(application, page, launchName, diagnostics) {
  page.on('pageerror', error => diagnostics.push({ launch: launchName, channel: 'pageerror', message: error.message }))
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.push({ launch: launchName, channel: 'console.error', message: message.text() })
  })
  await page.waitForFunction(() => !!window.whomi)
  await page.evaluate(() => {
    const messages = []
    window.__readingRuntimeErrors = messages
    window.addEventListener('error', event => {
      const message = event instanceof ErrorEvent ? event.message : event.target?.src ?? event.target?.href ?? 'Resource load error'
      messages.push({ channel: 'window.error', message })
    }, true)
    window.addEventListener('unhandledrejection', event => {
      messages.push({ channel: 'unhandledrejection', message: String(event.reason) })
    })
  })
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.showInactive()
    window.focus()
    window.webContents.focus()
  })
}

const normalizeNewlines = value => value.replaceAll('\r\n', '\n')

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
  const answer = normalizeNewlines(fixture.match(/```markdown\r?\n([\s\S]*?)\r?\n```/)[1])
  const partialPrefix = '  部分回答保留空白  \n第二行末尾也有空白   \n\n'
  const stopRetryAnswer = '停止轮重试完成。'
  const longAnswer = Array.from({ length: 24 }, () => answer).join('\n\n')
  const diagnostics = []
  const reading = {}
  const windowGeometry = []
  const requests = []
  let stopAttempts = 0
  let failNext = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const input = JSON.parse(body)
      const last = JSON.stringify(input.messages.at(-1))
      requests.push({ last, model: input.model })
      if (failNext) { failNext = false; response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: '合成连接失败，请重试。', type: 'invalid_request_error' } })); return }
      const firstStopAttempt = last.includes('部分停止检查') && ++stopAttempts === 1
      const slow = firstStopAttempt || last.includes('滚动检查')
      const text = firstStopAttempt ? partialPrefix + longAnswer
        : last.includes('部分停止检查') ? stopRetryAnswer
        : slow ? longAnswer
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
      }, slow ? 120 : 70)
      response.on('close', () => clearInterval(timer))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let application
  let page
  let observedLaunch
  const collectNativeErrors = async () => {
    if (!observedLaunch || !page || page.isClosed()) return
    const records = await page.evaluate(() => window.__readingRuntimeErrors ?? [])
    diagnostics.push(...records.map(record => ({ ...record, launch: observedLaunch })))
    observedLaunch = undefined
  }
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
    page = await application.firstWindow()
    await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.aiSeed', null))
    const models = await page.evaluate(async baseUrl => {
      const p = await window.whomi.settings.saveProvider({ name: '合成评审服务', baseUrl, enabled: true, apiKey: 'synthetic-test-key' })
      const a = await window.whomi.settings.saveModel({ providerId: p.id, label: '评审模型甲', model: 'model-a', contextWindow: 128000, maxTokens: 8192, enabled: true })
      const b = await window.whomi.settings.saveModel({ providerId: p.id, label: '评审模型乙', model: 'model-b', contextWindow: 128000, maxTokens: 8192, enabled: true })
      await window.whomi.settings.selectModel('conversation', a.id)
      return { a, b }
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await application.close()
    application = await launch()
    page = await application.firstWindow()
    observedLaunch = 'reading'
    await observeRuntime(application, page, observedLaunch, diagnostics)
    const resize = async (width, height = width === 960 ? 720 : 800) => {
      await application.evaluate(({ BrowserWindow }, { width, height }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(320, 320)
        window.setSize(width, height)
      }, { width, height })
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
    }
    const shot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
    const open = async () => {
      await page.getByRole('button', { name: '展开会话列表' }).click()
      await page.getByRole('button', { name: '合成阅读评审', exact: true }).click()
      await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
    }
    await resize(1280); await open()
    const input = page.getByRole('textbox', { name: '向 AI 提问' })
    const send = page.getByRole('button', { name: '发送给 AI' })
    const stop = page.getByRole('button', { name: '停止回答' })
    const log = page.getByRole('log')
    const viewport = page.locator('[data-message-virtual-list-scroller]')
    const stats = page.getByRole('region', { name: '生成统计' })
    const primaryMetrics = stats.locator('[data-testid="message-primary-metrics"] dd')
    const replyFor = turn => log.locator(`[data-message-id="${turn.requestId}:assistant"]`)
    const statsFor = reply => reply.getByRole('button', { name: /^输出 286 token/ })
    const thread = id => page.evaluate(id => window.whomi.ai.getThread(id), id)
    const lastTurn = async id => (await thread(id)).turns.at(-1)
    const waitForTurn = async (id, prompt, state) => {
      await expect.poll(async () => {
        const turn = await lastTurn(id)
        return turn && [turn.prompt, turn.state]
      }, { timeout: 30000 }).toEqual([prompt, state])
      return lastTurn(id)
    }
    const sendPrompt = async text => { await input.fill(text); await send.click() }
    const snapshot = anchorKey => viewport.evaluate((element, key) => {
      const bounds = element.getBoundingClientRect()
      const groups = [...element.querySelectorAll('[data-message-key]')]
      const anchor = key ? groups.find(group => group.dataset.messageKey === key)
        : groups.find(group => {
          const position = group.getBoundingClientRect()
          return position.bottom > bounds.top + 1 && position.top < bounds.bottom - 1
        })
      return {
        key: anchor?.dataset.messageKey,
        anchorY: anchor ? anchor.getBoundingClientRect().top - bounds.top : null,
        top: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      }
    }, anchorKey)
    const wheelUp = async pixels => {
      const bounds = await viewport.boundingBox()
      await page.mouse.move(bounds.x + 12, bounds.y + bounds.height / 2)
      await page.mouse.wheel(0, -pixels)
    }
    const goToEnd = async () => {
      await viewport.press('End')
      await expect.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    }
    await expect(page.getByRole('navigation', { name: 'AI 对话列表' })).toHaveCount(0)
    await sendPrompt('这段示例里，我怎样回应了朋友？')
    await expect(page.getByRole('button', { name: '复制回答' })).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    const firstThread = (await page.evaluate(() => window.whomi.ai.listThreads('1')))[0]
    const firstReply = replyFor(await lastTurn(firstThread.id))
    await expect(log.getByRole('heading')).toHaveCount(2)
    await expect(log.getByRole('listitem')).toHaveCount(3)
    await expect(log.getByRole('row')).toHaveCount(3)
    await expect(firstReply.locator('.message-header')).toContainText('评审模型甲')
    await viewport.press('Home')
    await shot('C01-whomi-after-1280x800')
    const widths = await page.evaluate(() => Object.fromEntries(['.conversation-source', '.conversation-ai-panel', '.conversation-thread-content'].map(s => [s, document.querySelector(s).getBoundingClientRect().width])))
    expect(widths['.conversation-thread-content']).toBeGreaterThan(600)
    await firstReply.getByRole('button', { name: '复制回答' }).click()
    await expect(firstReply.getByRole('button', { name: '已复制' })).toBeVisible()
    expect(normalizeNewlines(await application.evaluate(({ clipboard }) => clipboard.readText()))).toBe(answer)
    await statsFor(firstReply).click()
    await expect(stats).toContainText('评审模型甲')
    await expect(stats).toContainText('1,240 Tokens')
    await expect(stats).toContainText('286 Tokens')
    await expect(stats).toContainText('240 Tokens')
    await expect(stats).toContainText('1,000 Tokens')
    const primarySpeed = await primaryMetrics.nth(2).innerText()
    await expect(statsFor(firstReply)).toContainText(primarySpeed.replace('Token/秒', 'token/秒'))
    expect(await primaryMetrics.evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight))).toBe(true)
    await shot('C12-whomi-statistics-1280x800'); await page.keyboard.press('Escape')
    await expect(stats).toHaveCount(0)
    await expect(input).toBeVisible()
    await page.getByRole('combobox', { name: '对话模型' }).click()
    await page.getByRole('option', { name: '评审模型乙' }).click()
    await expect(firstReply.locator('.message-header')).toContainText('评审模型甲')
    await goToEnd()
    await sendPrompt('用乙继续观察')
    const secondTurn = await waitForTurn(firstThread.id, '用乙继续观察', 'completed')
    await expect(replyFor(secondTurn).locator('.message-header')).toContainText('评审模型乙')
    expect((await thread(firstThread.id)).turns).toHaveLength(2)
    await expect.soft.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    await goToEnd()
    const beforeWheel = await snapshot()
    await wheelUp(120)
    await expect.poll(async () => (await snapshot()).top).toBeLessThan(beforeWheel.top)
    await page.waitForTimeout(240)
    const historyAnchor = await snapshot()
    expect(historyAnchor.key).toBeDefined()
    reading.historyBefore = historyAnchor
    await input.fill('原对话的后续草稿')
    await page.getByRole('button', { name: '选择消息', exact: true }).click()
    await page.getByRole('option', { name: '本人：最卡住的是哪部分？' }).click()
    await page.getByRole('button', { name: '新建 AI 对话' }).click()
    await expect(input).toHaveText('')
    await input.fill('第二条对话的草稿')
    await page.getByRole('button', { name: '显示对话列表' }).click()
    await shot('C06-whomi-history-1280x800')
    await page.getByRole('navigation').getByRole('button', { name: firstThread.title, exact: true }).click()
    await expect(input).toHaveText('原对话的后续草稿')
    await expect.soft.poll(async () => {
      const restored = await snapshot(historyAnchor.key)
      return restored.anchorY === null ? Infinity : Math.abs(restored.anchorY - historyAnchor.anchorY)
    }).toBeLessThanOrEqual(2)
    reading.historyAfter = await snapshot(historyAnchor.key)
    await expect(page.getByRole('button', { name: '1 组引用', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '清空全部引用' }).click()
    await page.getByRole('button', { name: '显示对话列表' }).click(); await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '显示对话列表' })).toBeFocused()
    await page.getByRole('button', { name: '显示对话列表' }).click()
    await page.getByRole('button', { name: '关闭对话列表', exact: true }).click()
    await expect(page.getByRole('button', { name: '显示对话列表' })).toBeFocused()
    await goToEnd()
    failNext = true
    await sendPrompt('合成失败检查')
    const failed = await waitForTurn(firstThread.id, '合成失败检查', 'failed')
    const failedReply = replyFor(failed)
    await expect(failedReply.getByRole('button', { name: '重试回答' })).toBeVisible()
    await input.fill('失败后的下一条草稿')
    await failedReply.getByRole('button', { name: '重试回答' }).click()
    const recovered = await waitForTurn(firstThread.id, '合成失败检查', 'completed')
    expect(recovered).toMatchObject({ id: failed.id, attempt: failed.attempt + 1, text: answer })
    expect((await thread(firstThread.id)).turns).toHaveLength(3)
    await expect(failedReply.getByRole('button', { name: '复制回答' })).toBeVisible()
    await expect(input).toHaveText('失败后的下一条草稿')
    await shot('C18-whomi-retry-draft-1280x800')
    await sendPrompt('滚动检查')
    await expect(stop).toBeVisible()
    await input.fill('生成期间的下一条草稿')
    await input.press('Enter')
    await expect(input).toHaveText('生成期间的下一条草稿')
    expect((await thread(firstThread.id)).turns).toHaveLength(4)
    await expect.poll(async () => (await lastTurn(firstThread.id)).text.length).toBeGreaterThan(3 * answer.length)
    await expect.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    reading.following = await snapshot()
    await wheelUp(Math.ceil(reading.following.viewport * 1.5))
    const backToBottom = page.getByRole('button', { name: '回到最新消息' })
    await expect(backToBottom).toBeVisible()
    await page.waitForTimeout(240)
    reading.up = await snapshot()
    expect(reading.up.key).toBeDefined()
    expect(reading.up.top).toBeLessThan(reading.following.top)
    await expect.poll(async () => (await snapshot()).height).toBeGreaterThan(reading.up.height + 120)
    reading.growing = await snapshot(reading.up.key)
    expect(reading.growing.anchorY).not.toBeNull()
    expect(Math.abs(reading.growing.anchorY - reading.up.anchorY)).toBeLessThanOrEqual(2)
    await expect(stop).toBeVisible()
    await shot('C05-whomi-stream-reading-1280x800')
    await backToBottom.click()
    await expect.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    reading.returned = await snapshot()
    await expect.poll(async () => (await snapshot()).height).toBeGreaterThan(reading.returned.height + 120)
    await expect.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    reading.followedGrowth = await snapshot()
    await waitForTurn(firstThread.id, '滚动检查', 'completed')
    await expect(stop).toHaveCount(0)
    await expect.poll(async () => (await snapshot()).distance).toBeLessThan(4)
    await expect(input).toHaveText('生成期间的下一条草稿')

    await sendPrompt('部分停止检查')
    await expect.poll(async () => (await lastTurn(firstThread.id)).text.length).toBeGreaterThan(partialPrefix.length + 150)
    await stop.click()
    const stopped = await waitForTurn(firstThread.id, '部分停止检查', 'stopped')
    const stoppedReply = replyFor(stopped)
    expect(stopped.text.startsWith(partialPrefix)).toBe(true)
    await expect(stoppedReply.getByText('已停止回答。')).toBeVisible()
    reading.stoppedBefore = await snapshot()
    await page.waitForTimeout(3000)
    reading.stoppedAfter = await snapshot(reading.stoppedBefore.key)
    expect(Math.abs(reading.stoppedAfter.top - reading.stoppedBefore.top)).toBeLessThanOrEqual(2)
    expect(await lastTurn(firstThread.id)).toMatchObject({ id: stopped.id, state: 'stopped', text: stopped.text })
    await stoppedReply.getByRole('button', { name: '复制回答' }).click()
    await expect(stoppedReply.getByRole('button', { name: '已复制' })).toBeVisible()
    expect(normalizeNewlines(await application.evaluate(({ clipboard }) => clipboard.readText()))).toBe(stopped.text)
    await shot('C06-whomi-stopped-1280x800')
    await page.getByRole('combobox', { name: '对话模型' }).click()
    await page.getByRole('option', { name: '评审模型甲' }).click()
    await input.fill('停止后先写的下一条草稿')
    await stoppedReply.getByRole('button', { name: '重试回答' }).click()
    const stopRetry = await waitForTurn(firstThread.id, '部分停止检查', 'completed')
    expect(stopRetry).toMatchObject({ id: stopped.id, attempt: stopped.attempt + 1, text: stopRetryAnswer, modelIdentity: stopped.modelIdentity })
    expect(requests.filter(request => request.last.includes('部分停止检查')).map(request => request.model)).toEqual(['model-b', 'model-b'])
    expect((await thread(firstThread.id)).turns).toHaveLength(5)
    await expect(stoppedReply).toContainText(stopRetryAnswer)
    await expect(stoppedReply.getByRole('button', { name: '重试回答' })).toHaveCount(0)
    await expect(input).toHaveText('停止后先写的下一条草稿')
    await page.getByRole('button', { name: '新建 AI 对话' }).click()
    await sendPrompt('长内容检查')
    await expect(page.getByRole('button', { name: '复制回答' })).toBeVisible()
    const longThread = (await page.evaluate(() => window.whomi.ai.listThreads('1')))[0]
    const longTurn = await lastTurn(longThread.id)
    const longReply = replyFor(longTurn)
    for (const width of [960, 360, 1280]) {
      await resize(width)
      const height = width === 960 ? 720 : 800
      await expect(input).toBeVisible()
      await goToEnd()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const overflow = await longReply.locator('pre').evaluate(el => {
        const containers = []
        for (let node = el; node && !node.matches('.conversation-thread-content'); node = node.parentElement) {
          const styles = getComputedStyle(node)
          containers.push({
            component: node.dataset.slot || node.dataset.ui || node.className || node.tagName,
            width: styles.width, maxWidth: styles.maxWidth, display: styles.display, overflowX: styles.overflowX,
          })
        }
        return { scroll: el.scrollWidth, width: el.clientWidth, right: el.getBoundingClientRect().right, containers }
      })
      windowGeometry.push({ width, height, code: overflow })
      expect(overflow.scroll).toBeGreaterThan(overflow.width)
      expect(overflow.right).toBeLessThanOrEqual(width)
      await page.getByRole('combobox', { name: '对话模型' }).click()
      await expect(page.getByRole('option', { name: '评审模型乙' })).toBeVisible()
      await shot(`C19-whomi-models-${width}x${height}`); await page.keyboard.press('Escape')
      const latestReply = replyFor(await lastTurn(longThread.id))
      await statsFor(latestReply).click(); await expect(stats).toBeVisible()
      const panel = await page.getByRole('complementary', { name: 'AI 对话' }).boundingBox()
      const card = await stats.boundingBox()
      expect(card.x).toBeGreaterThanOrEqual(panel.x - 1)
      expect(card.x + card.width).toBeLessThanOrEqual(panel.x + panel.width + 1)
      await expect.poll(() => primaryMetrics.evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth))).toBe(true)
      await shot(`C19-whomi-statistics-${width}x${height}`); await page.keyboard.press('Escape')
      await expect(stats).toHaveCount(0)
      await input.fill('窄窗保留草稿'); await page.getByRole('button', { name: '关闭 AI 对话' }).click()
      await expect(page.getByRole('button', { name: 'AI 对话', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
      await expect(input).toHaveText('窄窗保留草稿'); await expect(input).toHaveCount(1)
      await goToEnd(); await shot(`C04-whomi-overflow-${width}x${height}`)
      if (width === 360) {
        failNext = true
        await sendPrompt('窄窗失败检查')
        const narrowFailed = await waitForTurn(longThread.id, '窄窗失败检查', 'failed')
        const narrowReply = replyFor(narrowFailed)
        await expect(narrowReply.getByRole('button', { name: '重试回答' })).toBeVisible()
        await input.fill('窄窗失败后的下一条草稿'); await shot('C19-whomi-failure-draft-360x800')
        await narrowReply.getByRole('button', { name: '重试回答' }).click()
        const narrowRecovered = await waitForTurn(longThread.id, '窄窗失败检查', 'completed')
        expect(narrowRecovered).toMatchObject({ id: narrowFailed.id, attempt: narrowFailed.attempt + 1 })
        await expect(narrowReply.getByRole('button', { name: '复制回答' })).toBeVisible()
        await expect(input).toHaveText('窄窗失败后的下一条草稿')
        await expect(input).toHaveCount(1)
      }
    }
    await application.evaluate(({ shell }) => { globalThis.__readingOpenedLinks = []; shell.openExternal = async url => { globalThis.__readingOpenedLinks.push(url) } })
    await page.getByRole('link', { name: '长链接' }).click()
    await expect.poll(() => application.evaluate(() => globalThis.__readingOpenedLinks.length)).toBe(1)
    await page.evaluate(() => { for (const url of ['file:///C:/Windows/notepad.exe', 'data:text/html,unsafe', 'https://user:password@example.com/']) window.open(url, '_blank') })
    expect(await application.evaluate(() => globalThis.__readingOpenedLinks.length)).toBe(1)
    await page.evaluate(async model => { await window.whomi.settings.saveModel({ id: model.id, providerId: model.providerId, label: '甲已改名', model: model.model, contextWindow: model.contextWindow, maxTokens: model.maxTokens, enabled: false }) }, models.a)
    await collectNativeErrors()
    await application.close()
    application = await launch()
    page = await application.firstWindow()
    observedLaunch = 'restarted'
    await observeRuntime(application, page, observedLaunch, diagnostics)
    const restored = await page.evaluate(id => window.whomi.ai.getThread(id), firstThread.id)
    expect(restored.turns[0].modelIdentity).toEqual({ id: models.a.id, version: 1, label: '评审模型甲', model: 'model-a' })
    expect(restored.turns.at(-1)).toMatchObject({
      id: stopRetry.id, attempt: stopRetry.attempt, state: 'completed', text: stopRetryAnswer, modelIdentity: stopped.modelIdentity,
    })
    await resize(1280); await open()
    await page.getByRole('button', { name: '显示对话列表' }).click()
    await page.getByRole('navigation').getByRole('button', { name: firstThread.title, exact: true }).click()
    const restoredViewport = page.locator('[data-message-virtual-list-scroller]')
    await restoredViewport.press('Home')
    await expect.poll(() => restoredViewport.evaluate(el => el.scrollTop)).toBeLessThan(4)
    await expect(page.locator(`[data-message-id="${restored.turns[0].requestId}:assistant"] .message-header`)).toContainText('评审模型甲')
    await shot('C11-whomi-restored-1280x800')
    const version = await application.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron }))
    await writeFile(join(evidence, 'environment.json'), JSON.stringify({ synthetic: true, version, theme: 'light', zoom: await page.evaluate(() => devicePixelRatio), dimensions: [[1280, 800], [960, 720], [360, 800]], widths, answer, completed: new Date().toISOString() }, null, 2))
  } catch (error) {
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: join(evidence, 'failure.png'), timeout: 5000 }) }
      catch (captureError) { diagnostics.push({ launch: observedLaunch, channel: 'capture', message: String(captureError) }) }
    }
    throw error
  } finally {
    try {
      await collectNativeErrors()
    } catch (error) {
      diagnostics.push({ launch: observedLaunch, channel: 'capture', message: String(error) })
    }
    await writeFile(join(evidence, 'reading-geometry.json'), JSON.stringify(reading, null, 2))
    await writeFile(join(evidence, 'window-geometry.json'), JSON.stringify(windowGeometry, null, 2))
    await writeFile(join(evidence, 'runtime-errors.json'), JSON.stringify(diagnostics, null, 2))
    await application?.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') && directory.includes('whomi-runtime-')) await rm(directory, { recursive: true, force: true })
  }
  expect(diagnostics, 'renderer runtime errors').toEqual([])
})
