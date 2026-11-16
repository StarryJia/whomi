import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { insightModelPrompt, insightModelReply, syntheticInsightConversation, syntheticInsightScope } from './fixtures/insight-model.mjs'

const evidence = resolve('release/conversation-insights-20261115')

async function failNext(app, method, fragmentIndex) {
  await app.evaluate(({ ipcMain }, target) => {
    const channel = 'whomi:ai-call', original = ipcMain._invokeHandlers.get(channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, value) => {
      if (value.method === target.method && (target.fragmentIndex === undefined || value.args[0]?.fragmentIndex === target.fragmentIndex)) {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, original)
        return { ok: false, error: { code: 'OPERATION_FAILED', action: '操作失败，请重试。' } }
      }
      return original(event, value)
    })
  }, { method, fragmentIndex })
}

function completion(response, result) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ id: 'synthetic-ui', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
  response.end(`data: ${JSON.stringify({ id: 'synthetic-ui', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
}

async function harness({ model = true, self = true, hold = true, reject = true, longReport = false } = {}) {
  const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-insight-ui-')))
  const requests = [], errors = [], fixtureErrors = []
  let app
  let holdCheck = hold, rejectWriting = reject
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      try {
        const prompt = insightModelPrompt(JSON.parse(body))
        requests.push(prompt)
        if (prompt.stage === 'checking' && holdCheck) {
          holdCheck = false
          response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return
        }
        if (prompt.stage === 'writing' && rejectWriting) {
          rejectWriting = false
          response.writeHead(500, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'Synthetic UI retry fixture', type: 'server_error' } })); return
        }
        const result = insightModelReply(prompt)
        if (longReport && prompt.stage === 'writing') {
          result.aboutYou.push(...Array.from({ length: 10 }, (_, index) => ({ content: [{ text: `合成阅读段落 ${index + 1}：你先给出三个办法，ta 表示想先说完，之后又主动询问主意。这些片段显示不同时间对建议的需要有所变化；仅凭本次聊天，不能把这种表达理解为固定的性格。` }] })))
          result.citations[0].fragments[0].messageIds = ['1', '3']
        }
        completion(response, result)
      } catch (error) { fixtureErrors.push(String(error)); response.end() }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const close = async () => {
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('whomi-runtime-insight-ui-')) await rm(directory, { recursive: true, force: true })
    }
  }
  try {
  await mkdir(evidence, { recursive: true })
  await writeFile(join(directory, 'insight-model.mjs'), await readFile(new URL('./fixtures/insight-model.mjs', import.meta.url), 'utf8'))
  await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => async method => {
    if (method !== 'probe.seedInsight') throw Error('Unsupported synthetic UI probe')
    const { seedSyntheticInsight } = await import('./insight-model.mjs')
    return writer.transaction(() => {
      seedSyntheticInsight(writer)
      if (!${self}) writer.exec('DELETE FROM self_confirmations')
      const add = writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms,time_precision) VALUES(?,1,?,'member',?,'text',?,?,?,'minute')")
      for (let i = 0; i < 140; i++) {
        add.run(100 + i, i % 2 + 1, i % 2 ? '合成对方' : '合成本人', '范围外较早聊天 ' + (i + 1), i + 144, Date.UTC(2026, 9, 1, 1, i))
        add.run(300 + i, i % 2 + 1, i % 2 ? '合成对方' : '合成本人', '范围外较晚聊天 ' + (i + 1), i + 4, Date.UTC(2026, 9, 12, 1, i))
      }
      return true
    })()
  }`)
  const launch = () => electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  app = await launch()
  let page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seedInsight', null))
  if (model) await page.evaluate(async baseUrl => {
    const provider = await window.whomi.settings.saveProvider({ name: '合成本地服务', baseUrl, enabled: true, apiKey: 'test-only-key' })
    await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成洞察模型', model: 'example', contextWindow: 12000, maxTokens: 1000, enabled: true })
  }, `http://127.0.0.1:${server.address().port}/v1`)
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1280, 900) })
  await expect(page.locator('.hello-cover')).toBeAttached()
  await expect(page.locator('.startup-intro')).toHaveCount(0)
  const btn = name => page.getByRole('button', { name, exact: true })
  if (await btn('展开侧栏').isVisible()) await btn('展开侧栏').click()
  if (await btn('展开会话列表').isVisible()) await btn('展开会话列表').click()
  await btn(syntheticInsightConversation).click()
  return {
    app, page, btn, requests, errors, fixtureErrors,
    shot: name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' }),
    close,
  }
  } catch (error) { await close(); throw error }
}

test('real Electron insight UI validates scope, pauses and retries, reads exact sources, renames and deletes', async () => {
  test.setTimeout(90_000)
  const h = await harness(), { page, app, btn, shot } = h
  const management = async name => {
    await btn('关闭会话洞察').click(); await btn('对话洞察').click()
    await expect(page.locator('.insight-task-row')).toBeVisible()
    await shot(name)
    if (name === '20-management-running') { await btn('详情').click(); await shot('21-management-details') }
    await btn(syntheticInsightConversation).click(); await btn('会话洞察').click()
  }
  try {
    await btn('会话洞察').click()
    await page.getByRole('combobox', { name: '分析模型', exact: true }).click()
    await page.getByRole('option', { name: /合成洞察模型/ }).click()
    await expect(btn('开始洞察')).toBeEnabled()
    await shot('01-startup-all')
    await btn('取消').click()
    expect(await page.evaluate(() => window.whomi.ai.listAnalyses('1'))).toEqual([])
    await btn('会话洞察').click()
    await page.getByRole('radio', { name: '日期范围', exact: true }).check()
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-12')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-09')
    await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期')
    await expect(btn('开始洞察')).toBeDisabled()
    await shot('02-startup-invalid-dates')
    await page.getByLabel('开始日期', { exact: true }).fill('2026-11-01')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-11-02')
    await expect(page.getByText('此范围没有消息，请调整日期。')).toBeVisible()
    await expect(btn('开始洞察')).toBeDisabled()
    await shot('03-startup-empty-range')
    await page.getByLabel('开始日期', { exact: true }).fill(syntheticInsightScope.startDate)
    await page.getByLabel('结束日期', { exact: true }).fill(syntheticInsightScope.endDate)
    await expect(page.locator('.insight-scope')).toContainText('3 条消息')
    await expect(btn('开始洞察')).toBeEnabled()
    await shot('04-startup-dates')
    await btn('开始洞察').click()
    await expect.poll(() => h.requests.map(request => request.stage), { timeout: 20_000 }).toEqual(['reading', 'checking'])
    await expect(btn('暂停生成')).toBeVisible()
    await shot('05-progress-collapsed')
    await btn('详情').click()
    await expect(page.getByRole('group', { name: '分析用量' })).toBeVisible()
    await shot('06-progress-expanded')
    await management('20-management-running')
    await btn('暂停生成').click()
    await expect(btn('继续洞察')).toBeEnabled()
    await shot('07-progress-paused')
    await management('22-management-paused')
    await btn('继续洞察').click()
    await expect(btn('重试')).toBeEnabled()
    await shot('08-progress-failed')
    await management('23-management-failed')
    await btn('重试').click()
    await expect(btn('查看报告')).toBeEnabled()
    await shot('09-progress-complete')
    await btn('查看报告').click()
    await expect(page.getByRole('heading', { name: '会话洞察', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '关于你' })).toBeVisible()
    await shot('10-report-reader')
    await btn('重命名').click()
    await expect(page.getByLabel('报告名称')).toBeFocused()
    await page.getByLabel('报告名称').fill('取消的名称')
    await btn('取消').click()
    await expect(btn('重命名')).toBeFocused()
    await expect(page.getByRole('heading', { name: '会话洞察', exact: true })).toBeVisible()
    await btn('重命名').click()
    await page.getByLabel('报告名称').fill('合成报告 · 建议与倾听')
    await shot('11-report-rename')
    await failNext(app, 'renameAnalysis')
    await btn('保存').click()
    await expect(page.getByRole('alert')).toContainText('保存失败，请重试。')
    await expect(page.getByLabel('报告名称')).toHaveValue('合成报告 · 建议与倾听')
    await shot('simulated-rename-save-failed')
    await btn('保存').click()
    await expect(page.getByRole('heading', { name: '合成报告 · 建议与倾听' })).toBeVisible()
    const citation = btn('你一开始就给了三个办法')
    await citation.focus(); await page.keyboard.press('Enter')
    const source = page.getByRole('region', { name: '引用聊天记录' })
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '1')
    await expect(source.locator('[data-message-id="2"]')).toHaveAttribute('data-citation', 'false')
    await expect(btn('上一段')).toBeDisabled()
    await expect(btn('回到引用')).toHaveCount(0)
    await shot('12-source-first')
    const positions = await source.evaluate(el => [...el.querySelectorAll('[data-message-id]')].slice(0, 10).map(message => {
      const avatar = message.querySelector('.conversation-avatar').getBoundingClientRect(), text = message.querySelector('.message-text').getBoundingClientRect()
      return { self: message.classList.contains('message-self'), avatarLeft: avatar.left, avatarRight: avatar.right, textLeft: text.left, textRight: text.right }
    }))
    expect(positions.every(position => position.self ? position.avatarLeft >= position.textRight : position.avatarRight <= position.textLeft)).toBe(true)
    const initialIds = await source.locator('[data-message-id]').evaluateAll(nodes => nodes.map(node => node.dataset.messageId))
    const beforeAnchor = await source.evaluate(el => {
      el.scrollTop = 0
      const top = el.getBoundingClientRect().top
      const first = [...el.querySelectorAll('[data-message-id]')].find(message => message.getBoundingClientRect().bottom > top)
      const anchor = { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - top }
      el.dispatchEvent(new Event('scroll'))
      return anchor
    })
    await expect.poll(() => source.locator('[data-message-id]').count()).toBeGreaterThan(initialIds.length)
    const beforeShift = await source.evaluate((el, anchor) => {
      const message = el.querySelector('[data-message-id="' + anchor.id + '"]')
      return Math.abs(message.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset)
    }, beforeAnchor)
    expect(beforeShift).toBeLessThan(2)
    await expect(btn('回到引用')).toBeVisible()
    await shot('13-source-browse-earlier')
    await btn('回到引用').click()
    await expect(btn('回到引用')).toHaveCount(0)
    const beforeLater = await source.locator('[data-message-id]').count()
    const afterAnchor = await source.evaluate(el => {
      el.scrollTop = el.scrollHeight
      const top = el.getBoundingClientRect().top
      const first = [...el.querySelectorAll('[data-message-id]')].find(message => message.getBoundingClientRect().bottom > top)
      const anchor = { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - top }
      el.dispatchEvent(new Event('scroll'))
      return anchor
    })
    await expect.poll(() => source.locator('[data-message-id]').count()).toBeGreaterThan(beforeLater)
    const afterShift = await source.evaluate((el, anchor) => {
      const message = el.querySelector('[data-message-id="' + anchor.id + '"]')
      return Math.abs(message.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset)
    }, afterAnchor)
    expect(afterShift).toBeLessThan(2)
    await expect(btn('回到引用')).toBeVisible()
    await shot('14-source-browse-later')
    await failNext(app, 'readInsightCitation', 1)
    await btn('下一段').click()
    await expect(page.getByRole('alert')).toContainText('原文读取失败，请重试。')
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '1')
    await expect(page.locator('.insight-source-footer')).toContainText('1 / 2')
    await shot('simulated-source-next-failed')
    await btn('重试').click()
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '3')
    await expect(btn('下一段')).toBeDisabled()
    await expect(btn('上一段')).toBeEnabled()
    await shot('15-source-second')
    await btn('关闭原文').click()
    await expect(citation).toBeFocused()
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(960, 640) })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
    await expect(page.locator('#app-sidebar')).toBeVisible()
    expect(await page.locator('#app-sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(240)
    await shot('16-narrow-report')
    await citation.click()
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '1')
    await shot('17-narrow-source')
    expect(await source.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await btn('下一段').click()
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '3')
    await btn('关闭原文').click()
    await expect(citation).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await btn('返回').click()
    await btn('对话洞察').click()
    const row = page.locator('.insight-report-row[data-list-id]')
    await expect(row).toContainText('合成报告 · 建议与倾听')
    await row.click()
    await btn('返回').click()
    await expect(row).toBeFocused()
    await shot('18-narrow-management')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const deletion = page.getByRole('dialog', { name: '删除报告' })
    await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await shot('19-delete-confirm')
    await deletion.getByRole('button', { name: '取消', exact: true }).click()
    await expect(row).toBeFocused()
    await row.click({ button: 'right' }); await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    await failNext(app, 'deleteAnalysis')
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(deletion.getByRole('alert')).toBeVisible()
    await expect(row).toBeVisible()
    await shot('simulated-delete-failed')
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByRole('heading', { name: '暂无洞察报告' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '对话洞察', exact: true })).toBeFocused()
    expect(await page.evaluate(async () => (await window.whomi.ai.previewInsightScope({ conversationId: '1', scope: { kind: 'all' } })).totalMessages)).toBe(284)
    expect(h.errors).toEqual([]); expect(h.fixtureErrors).toEqual([])
    expect(h.requests.flatMap(request => request.messages ?? []).every(message => ['1', '2', '3'].includes(message.id))).toBe(true)
    await writeFile(join(evidence, 'ui-results.json'), JSON.stringify({ pageErrors: h.errors, requests: h.requests.map(request => request.stage), pagination: { initial: initialIds.length, beforeLater, beforeShift, afterShift }, width: 960, height: 640, sidebar: 240 }, null, 2))
  } catch (error) {
    await shot('failure-ui')
    await writeFile(join(evidence, 'failure-ui.txt'), await page.locator('body').innerText())
    throw error
  } finally { await h.close() }
})

test('real Electron requires self selection and a model before creating an insight', async () => {
  test.setTimeout(60_000)
  const h = await harness({ model: false, self: false }), { page, btn, shot } = h
  try {
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await expect(identity).toBeVisible()
    await identity.getByRole('button', { name: '取消', exact: true }).click()
    await btn('会话洞察').click()
    await expect(identity).toBeVisible()
    await shot('24-self-required')
    await identity.getByRole('radio', { name: /合成本人/ }).check()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await expect(identity).toHaveCount(0)
    await expect(btn('开始洞察')).toHaveCount(0)
    await btn('会话洞察').click()
    await expect(page.getByText('暂无可用模型', { exact: true })).toBeVisible()
    await expect(btn('开始洞察')).toBeDisabled()
    await shot('25-startup-no-model')
    await btn('取消').click()
    expect(await page.evaluate(() => window.whomi.ai.listAnalyses('1'))).toEqual([])
    expect(h.requests).toEqual([])
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

test('real Electron report list shows loading and retryable first-read failure', async () => {
  test.setTimeout(60_000)
  const h = await harness({ model: false }), { app, page, btn, shot } = h
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const channel = 'whomi:ai-call', original = ipcMain._invokeHandlers.get(channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, value) => {
        if (value.method === 'listAnalyses' && !value.args.length) {
          await new Promise(resolve => { globalThis.__insightUiReleaseList = resolve })
          ipcMain.removeHandler(channel); ipcMain.handle(channel, original)
          return { ok: false, error: { code: 'OPERATION_FAILED', action: '操作失败，请重试。' } }
        }
        return original(event, value)
      })
      BrowserWindow.getAllWindows()[0].webContents.reload()
    })
    await expect(page.locator('.hello-cover')).toBeAttached()
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    await btn('对话洞察').click()
    await expect(page.getByText('正在读取报告列表…')).toBeVisible()
    await shot('simulated-26-management-loading')
    await app.evaluate(() => globalThis.__insightUiReleaseList())
    await expect(page.getByRole('heading', { name: '报告列表读取失败' })).toBeVisible()
    await shot('simulated-27-management-read-failed')
    await btn('重试').click()
    await expect(page.getByRole('heading', { name: '暂无洞察报告' })).toBeVisible()
    expect(h.requests).toEqual([])
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

test('real Electron preserves long report reading position and fits an 80-character title at 960 by 640', async () => {
  test.setTimeout(60_000)
  const h = await harness({ hold: false, reject: false, longReport: true }), { app, page, btn, shot } = h
  try {
    const task = await page.evaluate(async scope => {
      const models = await window.whomi.ai.listModels()
      const prepared = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId: models[0].id, scope })
      return window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId: 'synthetic-long-reader' })
    }, syntheticInsightScope)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 20_000 }).toMatchObject({ state: 'completed' })
    await btn('对话洞察').click()
    const row = page.locator('.insight-report-row[data-list-id]')
    await row.click()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(960, 640) })
    await expect(page.locator('.insight-prose footer')).not.toBeInViewport()
    await btn('重命名').click()
    const longTitle = '合成报告长名称与建议倾听'.repeat(8).slice(0, 80)
    await page.getByLabel('报告名称').fill(longTitle)
    await btn('保存').click()
    await expect(page.getByRole('heading', { name: longTitle, exact: true })).toBeVisible()
    await expect(btn('返回')).toBeInViewport()
    await expect(btn('重命名')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot('28-narrow-long-title')
    await btn('你一开始就给了三个办法').click()
    const noncontiguous = page.getByRole('region', { name: '引用聊天记录' })
    await expect.poll(() => noncontiguous.locator('[data-citation=true]').evaluateAll(nodes => nodes.map(node => node.dataset.messageId))).toEqual(['1', '3'])
    await expect(noncontiguous.locator('[data-message-id="2"]')).toHaveAttribute('data-citation', 'false')
    await shot('32-source-noncontiguous-evidence')
    await btn('关闭原文').click()
    const citation = btn('ta 也会主动问你有没有主意。')
    await citation.scrollIntoViewIfNeeded()
    const main = page.locator('main.insights-home')
    const top = await main.evaluate(el => el.scrollTop)
    expect(top).toBeGreaterThan(500)
    await expect(page.locator('.insight-prose footer')).toBeInViewport()
    await shot('29-long-report-bottom')
    await failNext(app, 'readInsightCitation')
    await citation.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toContainText('原文读取失败，请重试。')
    await expect(page.getByRole('region', { name: '引用聊天记录' }).locator('[data-message-id]')).toHaveCount(0)
    await shot('simulated-source-first-failed')
    await btn('重试').click()
    await expect(page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')).toHaveAttribute('data-message-id', '3')
    await shot('30-long-report-source')
    await page.keyboard.press('Escape')
    await expect(citation).toBeFocused()
    expect(await main.evaluate(el => el.scrollTop)).toBe(top)
    await shot('31-long-report-returned')
    await btn('返回').click()
    await expect(row).toBeFocused()
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})
