import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { meetingChat, completeModel, readTurns, sampleJudgments } from './fixtures/pi-insight-model.mjs'

test('失败任务重启后连续补读多页，沿用原断点完成并打开报告', async ({}, info) => {
  test.setTimeout(120_000)
  const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-reading-continuation-')))
  await writeFile(info.outputPath('profile-path.txt'), directory)
  await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
  const file = info.outputPath('合成聚会聊天.json')
  await writeFile(file, JSON.stringify(meetingChat(8)))
  let initialFailure = true
  let initialCalls = 0
  let earlyStops = 0
  const trace = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const input = JSON.parse(raw)
      appendFileSync(info.outputPath('requests.jsonl'), JSON.stringify(input) + '\n')
      if (initialFailure) {
        if (++initialCalls <= 2) return completeModel(response, { read: { messageId: String(initialCalls), before: 0, after: 0 } })
        response.writeHead(429, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Synthetic quota exhausted.' } }))
        return
      }
      const last = input.messages.at(-1)
      if (last.role === 'tool') {
        const page = readTurns(input).at(-1).result
        if (page.status !== 'ok' || page.messages.length !== 1) throw Error('Unexpected synthetic page')
        const id = page.messages[0].id
        trace.push({ action: 'page', id })
        if (id === '8') {
          const section = [{ content: [{ text: '今天路过活动室，顺手把窗户关上了。', citationId: 'c' }] }]
          completeModel(response, { text: JSON.stringify({ aboutYou: section, relationship: section,
            citations: [{ id: 'c', fragments: [{ messageIds: ['1'] }] }], limitations: [], judgments: sampleJudgments() }) })
        } else {
          earlyStops++
          completeModel(response, { text: '本页阅读完成，继续读取剩余聊天。' })
        }
      } else {
        const cursor = /"resumeCursor":"([^"]+)"/.exec(typeof last.content === 'string' ? last.content : (last.content ?? []).map(part => part.text ?? '').join(''))?.[1]
        if (!cursor) throw Error('Missing continuation cursor')
        const id = String(Number(cursor.split('.')[1]) + 1)
        trace.push({ action: 'continue', cursor, id })
        completeModel(response, { read: { messageId: id, before: 0, after: 0 } })
      }
    } catch (error) {
      trace.push({ action: 'fixture-error', message: String(error) })
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Synthetic fixture failure' } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app, page
  const button = name => page.getByRole('button', { name, exact: true })
  const task = () => page.evaluate(async () => (await window.whomi.ai.listAnalyses())[0])
  const shot = name => page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' })
  async function launch() {
    app = await electron.launch({ ...(process.env.WHOMI_DESKTOP_TEST_EXECUTABLE && { executablePath: process.env.WHOMI_DESKTOP_TEST_EXECUTABLE }),
      args: process.env.WHOMI_DESKTOP_TEST_EXECUTABLE ? ['--whomi-runtime-test'] : [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    await (await page.context().newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  }
  try {
    await launch()
    await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '合成续读服务', baseUrl, protocol: 'openai-completions', enabled: true, apiKey: 'synthetic-only' })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成续读模型', model: 'example', contextWindow: 128000, maxTokens: 8192, enabled: true })
      await window.whomi.settings.selectModel('analysis', model.id)
    }, 'http://127.0.0.1:' + server.address().port + '/v1')
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
    await expect.poll(task, { timeout: 30_000 }).toMatchObject({ state: 'failed', analyzedMessages: 1, totalMessages: 8 })
    const failed = await task()
    await writeFile(info.outputPath('before-resume.json'), JSON.stringify(failed, null, 2))
    await app.close(); await launch()
    await button('对话洞察').click()
    await expect(page.getByText(/已提交分析 1 \/ 8 条/)).toBeVisible()
    await shot('01-restored-failure')
    initialFailure = false
    await button('重试').click()
    await expect.poll(async () => {
      const current = await task()
      if (current.state === 'failed' && current.eventSequence > failed.eventSequence) throw Error('Continuation failed: ' + current.error)
      return current
    }, { timeout: 30_000 }).toMatchObject({ id: failed.id, state: 'completed', analyzedMessages: 8, totalMessages: 8 })
    expect(earlyStops).toBeGreaterThanOrEqual(3)
    expect(trace.some(event => event.action === 'fixture-error')).toBe(false)
    expect(trace.find(event => event.action === 'continue').id).toBe('2')
    expect(await page.evaluate(async () => (await window.whomi.ai.listAnalyses()).length)).toBe(1)
    await writeFile(info.outputPath('after-resume.json'), JSON.stringify(await task(), null, 2))
    await shot('02-completed')
    await page.getByRole('button', { name: new RegExp('会话洞察 #' + failed.id + '$') }).click()
    await expect(page.getByRole('heading', { name: '关于你' })).toBeVisible()
    await shot('03-report')
  } catch (error) {
    if (page && !page.isClosed()) {
      await shot('failure').catch(() => {})
      await writeFile(info.outputPath('failure-context.txt'), await page.locator('body').ariaSnapshot()).catch(() => {})
      await task().then(value => writeFile(info.outputPath('failure-task.json'), JSON.stringify(value, null, 2))).catch(() => {})
    }
    throw error
  } finally {
    await writeFile(info.outputPath('model-trace.json'), JSON.stringify(trace, null, 2))
    await app?.close()
    for (const name of ['logs', 'Crashpad']) await cp(join(directory, name), info.outputPath(name), { recursive: true }).catch(() => {})
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})
