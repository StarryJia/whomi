import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { insightModelPrompt, insightModelReply, syntheticInsightConversation, syntheticInsightScope } from './fixtures/insight-model.mjs'

const designStates = {
  'startup-current-conversation-v2': ['04-startup-dates'],
  'startup-scope-states-v1': ['01-startup-all', '02-startup-invalid-dates', '03-startup-empty-range', '25-startup-no-model'],
  'startup-self-required-v1': ['24-self-required'],
  'progress-collapsed-v1': ['05-progress-collapsed'],
  'progress-expanded-v1': ['06-progress-expanded'],
  'progress-task-states-v1': ['07-progress-paused', '08-progress-failed', '09-progress-complete'],
  'management-g-v2': ['20-management-running', '22-management-paused', '23-management-failed', '18-narrow-management'],
  'management-task-details-v1': ['21-management-details'],
  'management-list-read-states-v1': ['simulated-26-management-loading', 'simulated-27-management-read-failed'],
  'report-reader-rename-v1': ['11-report-rename', 'simulated-rename-save-failed'],
  'source-dialog-v2': ['12-source-first'],
  'source-dialog-states-v1': ['13-source-browse-earlier', 'simulated-source-next-failed'],
  'report-delete-confirm-v1': ['19-delete-confirm'],
}

async function captureDesignState(app, page, evidence, name) {
  const design = Object.entries(designStates).find(([, states]) => states.includes(name))?.[0]
  if (!design) return
  const png = await readFile(resolve('docs/designs/conversation-insights/assets', design + '.png'))
  const size = [png.readUInt32BE(16), png.readUInt32BE(20)]
  const viewport = () => page.evaluate(() => [innerWidth, innerHeight])
  const original = await viewport()
  async function resize(dimensions) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), dimensions)
    await expect.poll(viewport).toEqual(dimensions)
  }
  try {
    await resize(size)
    await page.screenshot({ path: join(evidence, 'design-' + name + '.png'), animations: 'disabled' })
  } finally {
    await resize(original)
  }
}

async function failNext(app, method, fragmentIndex, channel = 'whomi:ai-call', hold = false) {
  await app.evaluate(({ ipcMain }, target) => {
    const { channel } = target
    const original = ipcMain._invokeHandlers.get(channel)
    const attempts = []
    const gate = target.hold && new Promise(resolve => {
      globalThis.heldInsightFailure = { attempts, release: resolve }
    })
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, value) => {
      if (value.method === target.method && (target.fragmentIndex === undefined || value.args[0]?.fragmentIndex === target.fragmentIndex)) {
        attempts.push(value.args)
        if (gate) await gate
        ipcMain.removeHandler(channel); ipcMain.handle(channel, original)
        return { ok: false, error: { code: 'OPERATION_FAILED', action: '操作失败，请重试。' } }
      }
      return original(event, value)
    })
  }, { method, fragmentIndex, channel, hold })
}

function completion(response, result) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ id: 'synthetic-ui', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
  response.end(`data: ${JSON.stringify({ id: 'synthetic-ui', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
}

async function harness({ model = true, self = true, hold = true, reject = true, longReport = false, extraConversations = 0, distinctOverviewJudgments = false, conversationTitle = syntheticInsightConversation } = {}) {
  const evidence = test.info().outputPath('screenshots')
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
        if (distinctOverviewJudgments && prompt.stage === 'reading' && prompt.messages?.some(message => message.id === '4')) {
          result.candidates[0].supportingIds.push('4')
        }
        if (distinctOverviewJudgments && prompt.stage === 'checking' && result.action === 'finish' && prompt.check.supportingIds.includes('4')) {
          result.supportingIds.push('4')
        }
        if (distinctOverviewJudgments && prompt.stage === 'writing' && prompt.checks.some(check => check.finding?.supportingIds.includes('4'))) {
          result.judgments.push({ dimension: 'JP', direction: 'J', text: '你提前定好了见面时间。', supportingIds: ['4'],
            counterexampleIds: [], alternativeExplanations: [], limitations: ['仅限这次见面。'] })
        }
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
      writer.prepare('UPDATE conversations SET title=? WHERE id=1').run(${JSON.stringify(conversationTitle)})
      if (${distinctOverviewJudgments}) writer.prepare('UPDATE messages SET text=? WHERE id=4').run('我提前定好了周五见面的时间。')
      if (${extraConversations} > 0) {
        writer.exec('UPDATE conversations SET pinned=1 WHERE id=1')
        const addChat = writer.prepare("INSERT INTO conversations(title,kind,created_at_ms) VALUES(?,'direct',0)")
        for (let i = 1; i <= ${extraConversations}; i++) addChat.run('分页合成会话 ' + i)
      }
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
  async function openWindow() {
    app = await launch()
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    return page
  }
  async function restart() {
    await app.close()
    const page = await openWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 900) })
    try {
      await expect(page.locator('.hello-cover')).toBeAttached({ timeout: 15_000 })
      await expect(page.locator('.startup-intro')).toHaveCount(0)
    } catch (error) {
      await page.screenshot({ path: join(evidence, 'startup-failed.png') }).catch(() => {})
      throw error
    }
    const btn = name => page.getByRole('button', { name, exact: true })
    if (await btn('展开侧栏').isVisible()) await btn('展开侧栏').click()
    const shot = async name => {
      await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
      if (process.env.WHOMI_INSIGHT_DESIGN_SIZES === '1') await captureDesignState(app, page, evidence, name)
    }
    return { app, page, btn, shot }
  }
  const page = await openWindow()
  await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seedInsight', null))
  if (model) await page.evaluate(async baseUrl => {
    const provider = await window.whomi.settings.saveProvider({ name: '合成本地服务', baseUrl, enabled: true, apiKey: 'test-only-key' })
    await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成洞察模型', model: 'example', contextWindow: 12000, maxTokens: 1000, enabled: true })
  }, `http://127.0.0.1:${server.address().port}/v1`)
  const window = await restart()
  if (await window.btn('展开会话列表').isVisible()) await window.btn('展开会话列表').click()
  await window.btn(conversationTitle).click()
  return { ...window, requests, errors, fixtureErrors, evidence, restart, close }
  } catch (error) { await close(); throw error }
}

test('task row opens its progress from mouse and keyboard while actions stay on the list', async ({}, info) => {
  test.setTimeout(90_000)
  const h = await harness(), { app, page, btn, shot } = h
  const task = page.locator('.insight-task-row')
  const progress = page.getByRole('region', { name: '会话洞察状态' })
  const resize = width => app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(320, 320)
    window.setSize(width, 750)
  }, width)
  async function showList() {
    await expect(progress.getByRole('progressbar', { name: '消息处理进度' })).toBeVisible()
    await expect(progress.getByText('当前会话：' + syntheticInsightConversation)).toBeVisible()
    await btn('关闭会话洞察').click()
    await btn('对话洞察').click()
    await expect(task).toBeVisible()
  }
  try {
    await btn('会话洞察').click()
    await page.getByRole('combobox', { name: '分析模型', exact: true }).click()
    await page.getByRole('option', { name: /合成洞察模型/ }).click()
    await page.getByRole('radio', { name: '日期范围', exact: true }).check()
    await page.getByLabel('开始日期', { exact: true }).fill(syntheticInsightScope.startDate)
    await page.getByLabel('结束日期', { exact: true }).fill(syntheticInsightScope.endDate)
    await btn('开始洞察').click()
    await expect.poll(() => h.requests.map(request => request.stage), { timeout: 20_000 }).toEqual(['reading', 'checking'])
    await showList()
    const id = await task.getAttribute('data-insight-task')
    const title = task.getByRole('button', { name: new RegExp('会话洞察') })
    for (const locator of [
      title, task.locator('.memory-coverage-ring'), task.getByRole('status'),
      task.getByText(/^已运行 /), task.getByText('合成洞察模型', { exact: true }),
    ]) {
      await locator.click()
      await showList()
      await expect(task).toHaveAttribute('data-insight-task', id)
    }
    await task.getByRole('button', { name: '详情' }).click()
    await expect(task.getByRole('group', { name: '分析用量' })).toBeVisible()
    await expect(progress).toHaveCount(0)
    await task.getByRole('button', { name: '详情' }).click()
    await title.press('Enter')
    await showList()
    await title.focus()
    await page.keyboard.press('Tab')
    const pause = task.getByRole('button', { name: '暂停', exact: true })
    await expect(pause).toBeFocused()
    await page.keyboard.press('Space')
    await expect(task.getByRole('status')).toHaveText('已暂停')
    await expect(progress).toHaveCount(0)
    await resize(480)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480)
    const wrapped = await task.locator('.insight-task-row-actions').boundingBox()
    const top = await title.boundingBox()
    expect(wrapped.y).toBeGreaterThan(top.y + top.height)
    await shot('row-paused-wrapped')
    await task.click({ position: { x: 4, y: 4 } })
    await expect(progress.getByRole('status')).toHaveText('已暂停')
    await resize(1280)
    await showList()
    await task.getByRole('button', { name: '继续洞察' }).click()
    await expect(task.getByRole('status')).toHaveText('生成失败')
    await expect(progress).toHaveCount(0)
    await task.getByRole('button', { name: '重试' }).click()
    await expect(page.getByRole('button', { name: /会话洞察.*#1/ })).toBeVisible()
    await expect(task).toHaveCount(0)
    await expect(progress).toHaveCount(0)
    await shot('row-finished-after-retry')
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally { await h.close() }
})

test('real Electron insight UI validates scope, pauses and retries, reads exact sources, renames and deletes', async () => {
  test.setTimeout(90_000)
  const h = await harness(), { page, app, btn, shot, evidence } = h
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
    await expect(btn('会话洞察')).toBeVisible()
    await shot('startup-cancelled-in-conversation')
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
    const runtimeStats = page.locator('.insight-task-runtime dd')
    const elapsed = runtimeStats.first()
    const initialElapsed = await elapsed.innerText()
    await expect.poll(async () => {
      const currentElapsed = await elapsed.innerText()
      return /^\d{2}:\d{2}$/.test(currentElapsed) && currentElapsed > initialElapsed
    }).toBe(true)
    await shot('05-progress-collapsed')
    await btn('详情').click()
    await expect(page.getByRole('group', { name: '分析用量' })).toBeVisible()
    await shot('06-progress-expanded')
    await management('20-management-running')
    await btn('暂停生成').click()
    await expect(btn('继续洞察')).toBeEnabled()
    await shot('07-progress-paused')
    const pausedAt = Date.now()
    const pausedStats = await runtimeStats.allTextContents()
    await management('22-management-paused')
    await expect.poll(async () => ({
      stats: await runtimeStats.allTextContents(),
      waitedOneTick: Date.now() - pausedAt >= 1100,
    })).toEqual({ stats: pausedStats, waitedOneTick: true })
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1487, 1058))
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1487, 1058])
    await shot('reader-at-design-size')
    const appearance = await page.locator('.insight-citation').first().evaluate(link => {
      let background = 'rgba(0, 0, 0, 0)'
      for (let node = link; node && background === 'rgba(0, 0, 0, 0)'; node = node.parentElement) {
        background = getComputedStyle(node).backgroundColor
      }
      return { width: innerWidth, height: innerHeight, background, link: getComputedStyle(link).color,
        decoration: getComputedStyle(link).textDecorationLine, metadata: getComputedStyle(document.querySelector('.insight-reader-meta')).color }
    })
    await writeFile(join(evidence, 'report-appearance.json'), JSON.stringify(appearance, null, 2))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900))
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
    const renameNotice = page.getByRole('region', { name: '异常提醒' })
    await expect(renameNotice.getByRole('alert')).toHaveText('无法保存报告名称')
    const renameCause = renameNotice.getByText('保存失败，请重试。', { exact: true })
    await expect(renameCause).toBeHidden()
    await renameNotice.getByRole('button', { name: '展开详情', exact: true }).click()
    await expect(renameCause).toBeVisible()
    await expect(page.getByLabel('报告名称')).toHaveValue('合成报告 · 建议与倾听')
    await shot('simulated-rename-save-failed')
    await page.locator('.insight-rename').getByRole('button', { name: '保存', exact: true }).click()
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
    await btn('回到引用').press('Enter')
    await expect(source).toBeFocused()
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
    const beforeFailure = await source.evaluate(el => el.scrollTop)
    await failNext(app, 'readInsightCitation', 1)
    await btn('下一段').click()
    const sourceDialog = page.getByRole('dialog', { name: /^原文 · / })
    const sourceNotice = sourceDialog.getByRole('region', { name: '异常提醒' })
    await expect(sourceNotice.getByRole('alert')).toHaveText('原文读取失败，请重试。')
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '1')
    await expect(page.locator('.insight-source-footer')).toContainText('1 / 2')
    await shot('simulated-source-next-failed')
    expect(await source.evaluate(el => el.scrollTop)).toBe(beforeFailure)
    const noticeBounds = await sourceNotice.boundingBox()
    const sourceTitle = sourceDialog.getByRole('heading', { name: /^原文 · / })
    expect(noticeBounds.y + noticeBounds.height).toBeLessThan((await sourceTitle.boundingBox()).y)
    expect(Math.abs(noticeBounds.x + noticeBounds.width / 2 - (await page.evaluate(() => innerWidth)) / 2)).toBeLessThan(2)
    await btn('下一段').press('Enter')
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '3')
    await expect(source).toBeFocused()
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
    await failNext(app, 'readInsightCitation', 1)
    await btn('下一段').press('Enter')
    await expect(page.locator('.insight-source-footer')).toContainText('1 / 2')
    await sourceDialog.getByRole('button', { name: '重试', exact: true }).press('Enter')
    await expect(source.locator('[data-citation=true]')).toHaveAttribute('data-message-id', '3')
    await expect(page.locator('.insight-source-footer')).toContainText('2 / 2')
    await expect(source).toBeFocused()
    const topAfterRetry = await source.evaluate(el => el.scrollTop)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => source.evaluate(el => el.scrollTop)).toBeGreaterThan(topAfterRetry)
    await shot('narrow-source-keyboard-retry')
    await page.keyboard.press('Escape')
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
    const overlay = deletion.locator('.reader-modal-overlay')
    const clickOutsideDeleteCard = () => overlay.click({ position: { x: 12, y: 100 } })
    for (const dismiss of [() => page.keyboard.press('Escape'), clickOutsideDeleteCard]) {
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除', exact: true }).click()
      await dismiss()
      await expect(deletion).toHaveCount(0)
      await expect(row).toBeFocused()
    }

    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    await failNext(app, 'deleteAnalysis', undefined, 'whomi:ai-call', true)
    const id = await row.getAttribute('data-list-id')
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    try {
      const pending = deletion.getByRole('button', { name: '正在删除…', exact: true })
      await expect(pending).toBeDisabled()
      await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      await expect.poll(() => app.evaluate(() => globalThis.heldInsightFailure.attempts)).toEqual([[id]])
      await pending.press('Enter')
      await page.keyboard.press('Escape')
      await clickOutsideDeleteCard()
      await expect(deletion).toBeVisible()
      await expect(row).toBeVisible()
      expect(await app.evaluate(() => globalThis.heldInsightFailure.attempts)).toEqual([[id]])
      await shot('report-delete-pending')
    } finally {
      await app.evaluate(() => globalThis.heldInsightFailure.release())
    }
    await expect(deletion.getByRole('alert')).toBeVisible()
    await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeEnabled()
    await expect(row).toBeVisible()
    await shot('simulated-delete-failed')
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByRole('heading', { name: '暂无洞察报告' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '对话洞察', exact: true })).toBeFocused()
    await shot('report-delete-final-focus')
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

async function holdNextSourceReply(app, method) {
  await app.evaluate(({ ipcMain }, method) => {
    const channel = method === 'readMessages' ? 'whomi:call' : 'whomi:ai-call'
    const original = ipcMain._invokeHandlers.get(channel)
    delete globalThis.releaseSourceReply
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, value) => {
      if (value.method !== method) return original(event, value)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      const result = await original(event, value)
      await new Promise(resolve => { globalThis.releaseSourceReply = resolve })
      return result
    })
  }, method)
}

test('narrow citation dialog can close a pending read and change fragments during pagination', async ({}, info) => {
  const conversationTitle = '合成会话 · ' + 'QuarterlyReview'.repeat(15)
  const h = await harness({ hold: false, reject: false, conversationTitle }), { app, page, btn, shot } = h
  const source = page.getByRole('region', { name: '引用聊天记录' })
  const dialog = page.getByRole('dialog', { name: '原文 · ' + conversationTitle })
  const count = dialog.locator('.insight-source-footer')
  const highlighted = source.locator('[data-citation=true]')
  const held = () => expect.poll(() => app.evaluate(() => typeof globalThis.releaseSourceReply)).toBe('function')
  const release = () => app.evaluate(() => globalThis.releaseSourceReply?.())
  try {
    const task = await page.evaluate(async scope => {
      const [model] = await window.whomi.ai.listModels()
      const prepared = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId: model.id, scope })
      return window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId: 'source-dialog-late-reads' })
    }, syntheticInsightScope)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 20_000 }).toMatchObject({ state: 'completed' })
    const requests = h.requests.length
    await btn('对话洞察').click()
    await page.locator('.insight-report-row[data-list-id]').click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
    const first = btn('你一开始就给了三个办法'), second = btn('ta 也会主动问你有没有主意。')
    await holdNextSourceReply(app, 'readInsightCitation')
    await first.press('Enter')
    await held()
    await expect(dialog.getByRole('status')).toContainText('正在读取原文')
    await shot('source-loading-narrow-long-name')
    await expect(count).not.toContainText('1 / 2')
    await expect(source.locator('[data-message-id]')).toHaveCount(0)
    await expect(btn('关闭原文')).toBeInViewport()
    await expect(btn('关闭原文')).toBeFocused()
    await expect(dialog.getByText('引用：你一开始就给了三个办法', { exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(first).toBeFocused()
    await second.press('Enter')
    await expect(highlighted).toHaveAttribute('data-message-id', '3')
    await release()
    await expect(count).toContainText('1 / 1')
    await expect(dialog).toContainText('引用：ta 也会主动问你有没有主意。')
    await expect(highlighted).toHaveAttribute('data-message-id', '3')
    await btn('关闭原文').click()
    await expect(second).toBeFocused()

    await first.press('Enter')
    await expect(highlighted).toHaveAttribute('data-message-id', '1')
    await source.getByText('范围外较晚聊天 30', { exact: true }).scrollIntoViewIfNeeded()
    await expect(highlighted).not.toBeInViewport()
    await expect(btn('回到引用')).toBeVisible()
    await holdNextSourceReply(app, 'readInsightCitation')
    await btn('下一段').press('Enter')
    await held()
    await expect(btn('下一段')).toBeDisabled()
    await btn('回到引用').press('Enter')
    await expect(source).toBeFocused()
    await expect(highlighted).toBeInViewport({ ratio: 1 })
    await expect(btn('回到引用')).toHaveCount(0)
    await expect(count).toContainText('1 / 2')
    await release()
    await page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id)
    await source.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(highlighted).toHaveAttribute('data-message-id', '1')
    await expect(highlighted).toBeInViewport({ ratio: 1 })
    await expect(count).toContainText('1 / 2')
    await expect(btn('下一段')).toBeEnabled()
    await shot('source-return-after-late-fragment')

    await holdNextSourceReply(app, 'readMessages')
    await source.evaluate(viewport => { viewport.scrollTop = 0; viewport.dispatchEvent(new Event('scroll')) })
    await held()
    await expect(count).toContainText('1 / 2')
    await btn('下一段').press('Enter')
    await expect(highlighted).toHaveAttribute('data-message-id', '3')
    await expect(count).toContainText('2 / 2')
    const ids = () => source.locator('[data-message-id]').evaluateAll(rows => rows.map(row => row.dataset.messageId))
    const before = await ids()
    await release()
    await source.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await ids()).toEqual(before)
    await expect(source).toBeFocused()
    const viewport = await source.boundingBox(), previous = await btn('上一段').boundingBox(), next = await btn('下一段').boundingBox()
    expect(viewport.height).toBeGreaterThan(120)
    expect(previous.y + previous.height).toBeLessThanOrEqual(viewport.y)
    expect(next.y).toBeGreaterThanOrEqual(viewport.y + viewport.height)
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await shot('source-second-narrow-long-name')
    await page.keyboard.press('Escape')
    await expect(first).toBeFocused()
    expect(h.requests).toHaveLength(requests)
    expect(h.errors).toEqual([])
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await release()
    await h.close()
  }
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
    const listNotice = page.getByRole('region', { name: '异常提醒' })
    await expect(listNotice.getByRole('alert')).toHaveText('报告列表读取失败')
    await shot('simulated-27-management-read-failed')
    await page.locator('.insights-list').getByRole('button', { name: '重试', exact: true }).click()
    await expect(listNotice).toHaveCount(0)
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
    const sourceDialog = page.getByRole('dialog', { name: /^原文 · / })
    await expect(sourceDialog.getByRole('region', { name: '异常提醒' }).getByRole('alert')).toHaveText('原文读取失败，请重试。')
    await expect(page.getByRole('region', { name: '引用聊天记录' }).locator('[data-message-id]')).toHaveCount(0)
    await shot('simulated-source-first-failed')
    await sourceDialog.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')).toHaveAttribute('data-message-id', '3')
    await shot('30-long-report-source')
    await page.keyboard.press('Escape')
    await expect(citation).toBeFocused()
    expect(await main.evaluate(el => el.scrollTop)).toBe(top)
    await shot('31-long-report-returned')
    await btn('返回').click()
    await expect(row).toBeFocused()
    await row.click()
    await holdNextSourceReply(app, 'readInsightCitation')
    await citation.click()
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.releaseSourceReply))).toBe(true)
    await citation.evaluate(link => {
      window.removedCitationFocusEvents = 0
      link.addEventListener('focus', () => { window.removedCitationFocusEvents++ })
    })
    await shot('33-source-open-during-conversation-deletion')
    await page.evaluate(() => window.whomi.deleteConversation('1'))
    try {
      await expect(page.getByRole('region', { name: '引用聊天记录' })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '暂无洞察报告' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '对话洞察', exact: true })).toBeFocused()
      await expect(btn(syntheticInsightConversation)).toHaveCount(0)
    } catch (error) {
      await shot('failure-conversation-deletion-keeps-source-open')
      throw error
    } finally {
      await app.evaluate(() => globalThis.releaseSourceReply())
    }
    expect(await page.evaluate(() => window.whomi.ai.listAnalyses())).toEqual([])
    await expect(page.getByRole('region', { name: '引用聊天记录' })).toHaveCount(0)
    expect(await page.evaluate(() => window.removedCitationFocusEvents)).toBe(0)
    await shot('34-list-after-conversation-deletion')
    await btn('个人总览').click()
    await expect(page.getByRole('heading', { name: '你的人格倾向' })).toBeVisible()
    await expect(page.getByRole('region', { name: '你在不同关系中的表现' })).toHaveCount(0)
    await shot('35-overview-after-conversation-deletion')
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

test('real Electron retains elapsed insight time across abrupt exit', async ({}, info) => {
  test.setTimeout(75_000)
  const h = await harness({ reject: false })
  try {
    const { app, page, btn, shot } = h
    const task = await page.evaluate(async scope => {
      const [model] = await window.whomi.ai.listModels()
      const prepared = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId: model.id, scope })
      return window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId: 'synthetic-crash-running-insight' })
    }, syntheticInsightScope)
    await expect.poll(() => h.requests.map(request => request.stage), { timeout: 20_000 }).toEqual(['reading', 'checking'])
    const readTask = target => target.evaluate(id => window.whomi.ai.getAnalysis(id), task.id)
    const beforeWait = await readTask(page)
    await btn('对话洞察').click()
    await page.locator(`[data-insight-task="${task.id}"] .insight-task-link`).click()
    await expect(btn('暂停生成')).toBeVisible()
    const elapsed = page.locator('.insight-task-runtime dd').first()
    const visibleSeconds = async () => {
      const [minutes, seconds] = (await elapsed.innerText()).split(':').map(Number)
      return minutes * 60 + seconds
    }
    // 跨过完整的采样间隔，避免退出恰好发生在下一次写入前。
    await expect.poll(visibleSeconds, { timeout: 20_000 }).toBeGreaterThanOrEqual(Math.ceil(beforeWait.elapsedMs / 1000) + 11)
    await shot('running-before-abrupt-exit')
    const displayedAtExit = (await visibleSeconds()) * 1000
    const savedAtExit = (await readTask(page)).elapsedMs
    const child = app.process()
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    // 模拟进程突然结束，跳过应用的退出保存流程。
    const interruption = app.evaluate(() => process.exit(91)).catch(() => {})
    const exit = await exited
    await interruption
    expect(exit).toEqual({ code: 91, signal: null })
    await new Promise(resolve => setTimeout(resolve, 8_000))
    const restored = await h.restart()
    const recovered = await readTask(restored.page)
    await info.attach('elapsed-recovery.json', { contentType: 'application/json', body: JSON.stringify({
      taskId: task.id, exit, atRequest: beforeWait.elapsedMs, displayedAtExit, savedAtExit, recovered: recovered.elapsedMs,
    }, null, 2) })
    await restored.btn('对话洞察').click()
    const row = restored.page.locator(`[data-insight-task="${task.id}"]`)
    await expect(row).toContainText('生成失败')
    await restored.shot('interrupted-after-restart')
    expect(recovered).toMatchObject({ id: task.id, state: 'interrupted' })
    expect(recovered.elapsedMs).toBeGreaterThanOrEqual(beforeWait.elapsedMs + 4_000)
    expect(recovered.elapsedMs).toBeGreaterThanOrEqual(savedAtExit)
    expect(recovered.elapsedMs).toBeLessThanOrEqual(displayedAtExit + 2_000)

    await row.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => readTask(restored.page), { timeout: 20_000 }).toMatchObject({ id: task.id, state: 'completed' })
    expect((await readTask(restored.page)).elapsedMs).toBeGreaterThanOrEqual(recovered.elapsedMs)
    await expect(row.getByRole('button', { name: new RegExp('#' + task.id + '$') })).toBeVisible()
    await restored.shot('resumed-same-report')
    expect(h.fixtureErrors).toEqual([])
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

for (const resizeDuringReading of [false, true]) test(resizeDuringReading
  ? 'real Electron reveals focused report after resizing while reading'
  : 'real Electron restores a scrolled report list and its focus at 960 by 640', async () => {
  test.setTimeout(60_000)
  const h = await harness({ hold: false, reject: false }), { app, page, btn, shot } = h
  try {
    await app.evaluate(({ BrowserWindow, ipcMain }, width) => {
      BrowserWindow.getAllWindows()[0].setSize(width, width === 960 ? 640 : 900)
      const channel = 'whomi:ai-call'
      const original = ipcMain._invokeHandlers.get(channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, value) => {
        const result = await original(event, value)
        if (value.method !== 'listAnalyses' || value.args[0] !== undefined || !result.ok) return result
        const saved = result.value.find(task => task.state === 'completed' && task.report)
        if (!saved) return result
        // 只扩充渲染用的列表快照，打开的目标仍是实际保存的报告。
        const filler = Array.from({ length: 24 }, (_, index) => ({ ...saved, id: String(100 + index), title: '合成列表报告 ' + (index + 1) }))
        const otherGroup = { ...saved, id: '200', conversationId: '200', conversationTitle: '合成折叠分组' }
        return { ...result, value: [otherGroup, ...filler.slice(0, 16), saved, ...filler.slice(16)] }
      })
    }, resizeDuringReading ? 1280 : 960)
    const task = await page.evaluate(async scope => {
      const [model] = await window.whomi.ai.listModels()
      const preparation = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId: model.id, scope })
      return window.whomi.ai.confirmAnalysis({ token: preparation.token, requestId: 'synthetic-list-scroll' })
    }, syntheticInsightScope)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 20_000 })
      .toMatchObject({ state: 'completed' })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(resizeDuringReading ? 1280 : 960)
    await btn('对话洞察').click()
    const otherGroup = btn('合成折叠分组（1）')
    await otherGroup.click()
    await expect(otherGroup).toHaveAttribute('aria-expanded', 'false')
    const row = btn(`${syntheticInsightConversation} · 会话洞察 #${task.id}`)
    const main = page.locator('main.insights-home')
    const scrollTop = () => main.evaluate(element => element.scrollTop)
    await row.scrollIntoViewIfNeeded()
    await row.focus()
    const listTop = await scrollTop()
    expect(listTop).toBeGreaterThan(500)
    await shot('narrow-list-before-reading')
    await row.press('Enter')
    await expect(btn('你一开始就给了三个办法')).toBeVisible()
    expect(await scrollTop()).toBe(0)
    if (resizeDuringReading) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
      await shot('narrow-report-before-return')
    }
    await btn('返回').press('Enter')
    await expect(row).toBeFocused()
    await shot('narrow-list-after-returning')
    await expect(row).toBeInViewport()
    if (!resizeDuringReading) expect(await scrollTop()).toBe(listTop)
    await expect(otherGroup).toHaveAttribute('aria-expanded', 'false')
    expect(await main.evaluate(element => element.scrollWidth)).toBe(await main.evaluate(element => element.clientWidth))
    expect(h.fixtureErrors).toEqual([])
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

test('real Electron keeps same-name reports independent and rebuilds overview after deletion and restart', async () => {
  test.setTimeout(90_000)
  const h = await harness({ hold: false, reject: false, distinctOverviewJudgments: true })
  let { app, page, btn, shot } = h
  const observations = () => page.getByRole('region', { name: '你在不同关系中的表现' })
  async function generateReport(scope, requestId) {
    const task = await page.evaluate(async ({ scope, requestId }) => {
      const [model] = await window.whomi.ai.listModels()
      const prepared = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId: model.id, scope })
      return window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId })
    }, { scope, requestId })
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 20_000 })
      .toMatchObject({ state: 'completed', title: '会话洞察' })
    return task.id
  }

  try {
    const kept = await generateReport(syntheticInsightScope, 'synthetic-overview-kept')
    await btn('个人总览').click()
    await expect(btn(`会话洞察 #${kept}`)).toBeVisible()
    const removed = await generateReport({ ...syntheticInsightScope, endDate: '2026-10-11' }, 'synthetic-overview-removed')
    expect(removed).not.toBe(kept)
    await expect(btn(`会话洞察 #${removed}`)).toBeVisible()
    await expect(observations().getByText('???J', { exact: true })).toBeVisible()
    const report = await page.evaluate(id => window.whomi.ai.getReport(id), removed)
    expect(report.judgments).toContainEqual(expect.objectContaining({
      dimension: 'JP', direction: 'J', supportingSources: [{ messageId: '4', revision: expect.any(String) }],
    }))
    const requestsAfterGeneration = h.requests.length
    const renamed = '合成报告 · 两份同名报告'
    const originalKeptRow = btn(`${syntheticInsightConversation} · 会话洞察 #${kept}`)
    const originalRemovedRow = btn(`${syntheticInsightConversation} · 会话洞察 #${removed}`)
    const keptRow = () => btn(`${syntheticInsightConversation} · ${renamed} #${kept}`)
    const removedRow = () => btn(`${syntheticInsightConversation} · ${renamed} #${removed}`)
    const keptContribution = () => btn(`${renamed} #${kept}`)
    const removedContribution = () => btn(`${renamed} #${removed}`)

    await btn('对话洞察').click()
    await expect(originalKeptRow).toBeVisible()
    const conversationRow = () => btn(syntheticInsightConversation)
    async function requestDelete() {
      const dialog = page.getByRole('dialog', { name: '删除会话' })
      await conversationRow().click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除', exact: true }).click()
      await expect(dialog).toContainText('此会话的全部洞察报告')
      return dialog
    }
    let deleteConversation = await requestDelete()
    await expect(deleteConversation.getByRole('button', { name: '取消' })).toBeFocused()
    await shot('conversation-delete-scope')
    await deleteConversation.getByRole('button', { name: '取消' }).click()
    for (const report of [originalKeptRow, originalRemovedRow]) {
      await report.click()
      await expect(btn('你一开始就给了三个办法')).toBeVisible()
      await btn('返回').click()
    }
    await originalRemovedRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
    await page.getByRole('textbox', { name: '报告名称' }).fill(renamed)
    await failNext(app, 'listAnalyses')
    await btn('保存').click()
    const refreshError = page.getByRole('region', { name: '异常提醒' }).getByRole('alert').filter({ hasText: '报告列表读取失败' })
    await expect(refreshError).toHaveText('报告列表读取失败')
    await expect(originalKeptRow).toBeVisible()
    await expect(removedRow()).toBeVisible()
    await shot('simulated-management-refresh-failed-with-reports')
    await page.locator('.insights-list').getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('heading', { name: '对话洞察', exact: true })).toBeFocused()
    await expect(refreshError).toHaveCount(0)
    await expect(originalKeptRow).toBeVisible()
    await expect(removedRow()).toBeVisible()
    await originalKeptRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
    await page.getByRole('textbox', { name: '报告名称' }).fill(renamed)
    await btn('保存').click()
    await expect(keptRow()).toBeVisible()
    expect(h.requests).toHaveLength(requestsAfterGeneration)

    await btn('个人总览').click()
    await expect(keptContribution()).toBeVisible()
    await expect(removedContribution()).toBeVisible()
    await expect(observations().getByText('???J', { exact: true })).toBeVisible()
    await removedContribution().scrollIntoViewIfNeeded()
    await shot('overview-two-report-sources')

    await btn('对话洞察').click()
    await removedRow().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '删除报告' })
    await expect(dialog).toContainText(`${renamed} · #${removed}`)
    await expect(dialog).toContainText('2026.10.11')
    await expect(dialog).toContainText(syntheticInsightConversation)
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(removedRow()).toHaveCount(0)
    await expect(keptRow()).toBeFocused()

    await btn('个人总览').click()
    await expect(removedContribution()).toHaveCount(0)
    await expect(keptContribution()).toBeVisible()
    await expect(observations().getByText('????', { exact: true })).toBeVisible()
    await keptContribution().scrollIntoViewIfNeeded()
    await shot('overview-one-report-source-after-deletion')
    await keptContribution().click()
    await btn('你一开始就给了三个办法').click()
    const source = page.getByRole('region', { name: '引用聊天记录' })
    const evidence = source.locator('[data-citation=true]')
    await expect(evidence.getByText('我先给你三个办法。', { exact: true })).toBeVisible()
    await btn('关闭原文').click()
    await btn(syntheticInsightConversation).click()
    await expect(page.getByRole('heading', { name: syntheticInsightConversation, exact: true })).toBeVisible()

    ;({ app, page, btn, shot } = await h.restart())
    await btn('个人总览').click()
    await expect(keptContribution()).toBeVisible()
    await expect(removedContribution()).toHaveCount(0)
    await expect(observations().getByText('????', { exact: true })).toBeVisible()
    await keptContribution().scrollIntoViewIfNeeded()
    await shot('overview-after-restart')
    await btn('对话洞察').click()
    await expect(removedRow()).toHaveCount(0)
    await keptRow().click()
    await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible()
    if (await btn('展开会话列表').isVisible()) await btn('展开会话列表').click()
    deleteConversation = await requestDelete()
    await failNext(app, 'deleteConversation', undefined, 'whomi:call')
    await deleteConversation.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(deleteConversation.getByRole('alert')).toBeVisible()
    expect((await page.evaluate(() => window.whomi.ai.listAnalyses())).map(task => task.id)).toContain(kept)
    await failNext(app, 'listConversations', undefined, 'whomi:call')
    await deleteConversation.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(deleteConversation).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '暂无洞察报告' })).toBeVisible()
    await shot('list-after-confirmed-conversation-deletion')
    await expect(conversationRow()).toHaveCount(0)
    await expect(btn('导入会话')).toBeVisible()
    await expect(btn('重试会话列表')).toHaveCount(0)
    await btn('个人总览').click()
    await expect(keptContribution()).toHaveCount(0)
    await expect(observations()).toHaveCount(0)
    await expect(page.getByText('尚待了解', { exact: true })).toHaveCount(4)
    await shot('overview-without-valid-sources')
    expect(h.requests).toHaveLength(requestsAfterGeneration)
    expect(h.fixtureErrors).toEqual([])
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

test('deleting the last visible conversation preserves order and access to the next page', async () => {
  const h = await harness({ model: false, extraConversations: 100 }), { app, page, btn, shot } = h
  try {
    const rows = page.locator('.conversation-item[data-list-id]')
    const ids = () => rows.evaluateAll(elements => elements.map(el => el.dataset.listId))
    const all = await page.evaluate(async () => (await window.whomi.listConversations({ limit: 200 })).items.map(item => item.id))
    expect(all).toHaveLength(101)
    await expect.poll(ids).toEqual(all.slice(0, 100))
    const boundary = all[99]
    await app.evaluate(({ ipcMain }) => {
      const channel = 'whomi:call', original = ipcMain._invokeHandlers.get(channel)
      globalThis.sidebarReloads = 0
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, value) => {
        if (value.method === 'listConversations' && !value.args[0]?.cursor) {
          globalThis.sidebarReloads++
          return { ok: false, error: { code: 'OPERATION_FAILED', action: '读取失败，请重试。' } }
        }
        return original(event, value)
      })
    })
    async function remove(id) {
      await page.locator(`.conversation-item[data-list-id="${id}"]`).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除', exact: true }).click()
      await page.getByRole('dialog', { name: '删除会话' }).getByRole('button', { name: '确认删除' }).click()
      await expect(page.getByRole('dialog', { name: '删除会话' })).toHaveCount(0)
    }
    await remove(boundary)
    await btn('加载更多会话').click()
    await expect.poll(ids).toEqual(all.filter(id => id !== boundary))
    await expect(rows.first()).toHaveAttribute('data-pinned', 'true')
    await expect(btn('加载更多会话')).toHaveCount(0)
    await shot('sidebar-after-deleting-page-boundary')
    const middle = all[50]
    await remove(middle)
    await expect.poll(ids).toEqual(all.filter(id => id !== boundary && id !== middle))
    await expect(btn('重试会话列表')).toHaveCount(0)
    expect(await app.evaluate(() => globalThis.sidebarReloads)).toBe(0)
    const lastTitle = await rows.last().getAttribute('aria-label')
    await rows.last().click()
    await expect(page.getByRole('heading', { name: lastTitle, exact: true })).toBeVisible()
  } finally { await h.close() }
})
