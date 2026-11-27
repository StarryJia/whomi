import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { meetingChat, meetingModel, excerptCaption } from './fixtures/pi-insight-model.mjs'

test('额度失败后取消换模、拒绝无效模型，重启后跨服务商接续原报告', async ({}, info) => {
  test.setTimeout(150_000)
  const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-resume-')))
  await writeFile(info.outputPath('profile-path.txt'), directory)
  await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
  const file = info.outputPath('合成聚会聊天.json')
  await writeFile(file, JSON.stringify(meetingChat(8)))
  let originalCalls = 0
  const original = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const input = JSON.parse(raw)
    appendFileSync(info.outputPath('original-requests.jsonl'), JSON.stringify(input) + '\n')
    const index = ++originalCalls
    if (index > 2) {
      response.writeHead(429, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You have no credits remaining.' } }))
      return
    }
    const item = { type: 'function_call', id: 'fc_resume_' + index, call_id: 'call_resume_' + index,
      name: 'read_messages', arguments: JSON.stringify(index === 1 ? { messageId: '1', before: 0, after: 0 } : {}) }
    const frames = [{ type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response_resume_' + index, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10 } } }]
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
  })
  await new Promise(resolve => original.listen(0, '127.0.0.1', resolve))
  const trace = []
  const replacement = await meetingModel({ count: 8, profileDirectory: directory, observe: event => {
    trace.push(event); appendFileSync(info.outputPath('replacement-trace.jsonl'), JSON.stringify(event) + '\n')
  } })
  let app, page
  const task = () => page.evaluate(async () => (await window.whomi.ai.listAnalyses())[0])
  const button = name => page.getByRole('button', { name, exact: true })
  const shot = name => page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' })
  async function launch() {
    app = await electron.launch({ ...(process.env.WHOMI_DESKTOP_TEST_EXECUTABLE && { executablePath: process.env.WHOMI_DESKTOP_TEST_EXECUTABLE }),
      args: process.env.WHOMI_DESKTOP_TEST_EXECUTABLE ? ['--whomi-runtime-test'] : [resolve(process.env.WHOMI_DESKTOP_TEST_ENTRY ?? 'out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.hello-cover')).toBeAttached({ timeout: 20_000 })
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    await (await page.context().newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  }
  try {
    await launch()
    const ids = await page.evaluate(async urls => {
      const api = window.whomi
      const provider = await api.settings.saveProvider({ name: '额度耗尽服务', baseUrl: urls[0], protocol: 'openai-responses', enabled: true, apiKey: 'synthetic-only' })
      const model = await api.settings.saveModel({ providerId: provider.id, label: '原始分析模型', model: 'example', contextWindow: 128000, maxTokens: 8192, enabled: true })
      const other = await api.settings.saveProvider({ name: '接续服务', baseUrl: urls[1], protocol: 'openai-completions', enabled: true, apiKey: 'synthetic-only' })
      const next = await api.settings.saveModel({ providerId: other.id, label: '接续分析模型', model: 'example', contextWindow: 64000, maxTokens: 8192, enabled: true })
      await api.settings.selectModel('analysis', model.id)
      return { original: model.id, replacement: next.id }
    }, ['http://127.0.0.1:' + original.address().port + '/v1', replacement.baseUrl])
    await app.close(); await launch()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    await button('导入会话').click(); await button('选择文件').click(); await button('打开会话').click({ timeout: 60_000 })
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await identity.getByRole('radio', { name: /合成本人/ }).check()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await button('会话洞察').click()
    await page.getByRole('radio', { name: '日期范围' }).check()
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-07')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-07')
    await expect(page.locator('.insight-scope')).toContainText('8 条消息')
    await button('开始洞察').click()
    await expect.poll(task, { timeout: 30_000 }).toMatchObject({ state: 'failed', analyzedMessages: 1, totalMessages: 8, error: expect.stringContaining('额度或消费上限') })
    const failed = await task()
    await writeFile(info.outputPath('failed-task.json'), JSON.stringify(failed, null, 2))
    await button('更换模型并继续').click()
    await page.getByRole('combobox', { name: '接续模型' }).click()
    await page.getByRole('option', { name: '接续分析模型' }).click()
    await button('取消').click()
    expect(await task()).toMatchObject({ id: failed.id, state: 'failed', modelId: ids.original, analyzedMessages: 1 })
    expect(trace).toHaveLength(0)
    const invalid = await page.evaluate(async id => {
      try { await window.whomi.ai.continueAnalysis(id, { modelId: '999999999' }); return null }
      catch (error) { return { code: error.code } }
    }, failed.id)
    expect(invalid.code).toBe('INVALID_MODEL')
    expect(await task()).toMatchObject({ id: failed.id, modelId: ids.original, analyzedMessages: 1 })
    await app.close(); await launch()
    await button('对话洞察').click()
    await expect(page.getByText(/已提交分析 1 \/ 8 条/)).toBeVisible()
    await button('更换模型并继续').click()
    await page.getByRole('combobox', { name: '接续模型' }).click()
    await page.getByRole('option', { name: '接续分析模型' }).click()
    await shot('01-switch-provider')
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 320); window.setContentSize(480, 800)
    })
    await button('确认并继续').scrollIntoViewIfNeeded()
    await expect(button('确认并继续')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot('02-switch-narrow')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    await button('确认并继续').click()
    await expect.poll(async () => {
      const value = await task()
      if (value.modelId === ids.replacement && value.state === 'failed') throw Error('Resume failed: ' + JSON.stringify(value.error))
      return value
    }, { timeout: 60_000 }).toMatchObject({ id: failed.id, state: 'completed', modelId: ids.replacement, analyzedMessages: 8, totalMessages: 8 })
    expect(await page.evaluate(async () => (await window.whomi.ai.listAnalyses()).length)).toBe(1)
    expect(originalCalls).toBe(3)
    expect(trace.some(event => event.action === 'mock-error')).toBe(false)
    await writeFile(info.outputPath('completed-task.json'), JSON.stringify(await task(), null, 2))
    await expect(page.locator('.insight-report-row')).not.toContainText('接续分析模型')
    await shot('03-completed-list')
    await page.getByRole('button', { name: new RegExp('会话洞察 #' + failed.id + '$') }).click()
    await expect(page.getByRole('heading', { name: '关于你' })).toBeVisible()
    await expect(page.locator('.insight-reader-meta')).not.toContainText('模型')
    await shot('04-report')
    await button(excerptCaption[0]).click()
    await expect(page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')).toBeVisible()
    await shot('05-source')
    await button('关闭原文').click()
  } catch (error) {
    if (page && !page.isClosed()) {
      await shot('failure').catch(() => {})
      await writeFile(info.outputPath('failure-context.txt'), await page.locator('body').ariaSnapshot()).catch(() => {})
      await task().then(value => writeFile(info.outputPath('failure-task.json'), JSON.stringify(value, null, 2))).catch(() => {})
    }
    throw error
  } finally {
    await app?.close()
    for (const name of ['logs', 'Crashpad']) await cp(join(directory, name), info.outputPath(name), { recursive: true }).catch(() => {})
    await replacement.close()
    original.closeAllConnections(); await new Promise(resolve => original.close(resolve))
  }
})
