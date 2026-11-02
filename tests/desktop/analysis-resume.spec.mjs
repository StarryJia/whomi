import { _electron as electron, expect, test } from '@playwright/test'
import { sourceMessages } from './fixtures/moving-chat.mjs'
import { memoryModelReply } from './fixtures/memory-model.mjs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

test('resume a paused analysis after restart, retaining committed work and reporting against the same task', async () => {
  test.setTimeout(180000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-analysis-resume-'))
  const evidence = resolve('artifacts/memory-library')
  const title = '我和小林 · 周六搬家'
  const total = sourceMessages.length
  const summary = '从商量交钥匙到货车抵达东门，你们一起把书箱送进新家。'
  let eventTitle = '周六搬家'
  let includeDirection = false
  let invalidFinals = 2
  const batches = []
  let holdSecondBatch = true
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const messages = JSON.parse(body).messages
      const lastPrompt = JSON.stringify(messages.at(-1).content)
      const markers = [...lastPrompt.matchAll(/笔记(\d{2})/g)].map(match => match[1])
      if (markers.length) {
        batches.push(markers)
        // Hold one in-flight request so the preceding checkpoint definitely exists at the click.
        if (holdSecondBatch && batches.length > 1) return
      }
      let text = memoryModelReply(messages, { title: eventTitle, text: summary })
      if (includeDirection) {
        const reply = JSON.parse(text)
        if (reply.dimensions) reply.dimensions.JP = 'J'
        else if (markers.includes('01')) reply.events[0].signals = [{ direction: 'J', messageId: '1' }]
        text = JSON.stringify(reply)
      }
      if (invalidFinals > 0 && JSON.stringify(messages[0]).includes('撰写《我们的记忆》')) {
        invalidFinals--
        text = '无效文稿'
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 28, completion_tokens: 16, total_tokens: 44 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app, page
  async function launch() {
    app = await electron.launch({
      ...(process.env.WHOMI_PACKAGED_EXECUTABLE
        ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
        : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    page = await app.firstWindow()
  }
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(320, 320)
      window.setSize(width, 800)
    }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  }
  async function openConversation() {
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('button', { name: '整理成记忆', exact: true }).click()
  }
  const screenshot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
  const tasks = () => app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.tasks', null))
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), `module.exports = (writer, reader) => async method => {
      if (method === 'probe.tasks') {
        return reader.prepare("SELECT t.id,t.state,(SELECT count(*) FROM ai_analysis_coverage c WHERE c.task_id=t.id) AS covered FROM ai_analysis_tasks t ORDER BY t.id").all()
          .map(row => ({ id: String(row.id), state: row.state, analyzedMessages: Number(row.covered) }))
      }
      if (method !== 'probe.seed') throw Error('Unsupported')
      writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'${title}','direct',0);" +
        "INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');" +
        "INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人'),(2,1,1,'reader','朋友');" +
        "INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');")
      const insert = writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(?,1,?,'member',?,'text',?,?,?)")
      for (let n = 1; n <= ${total}; n++) {
        const mine = n % 2 === 1
        const text = ${JSON.stringify(sourceMessages)}[n-1]
        insert.run(n, mine ? 1 : 2, mine ? '本人' : '朋友', '笔记' + String(n).padStart(2, '0') + ' · ' + text, n - 1, 1761700000000 + n * 120000)
      }
      writer.prepare("INSERT INTO conversation_summaries(conversation_id,message_count,member_count,status) VALUES(1,?,2,'ready')").run(${total})
      return true
    }`)
    await launch()
    await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seed', null))
    await page.evaluate(async endpoint => {
      const provider = await window.whomi.settings.saveProvider({ name: '本机验收服务', baseUrl: endpoint, enabled: true, apiKey: 'test-only' })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '分析示例模型', model: 'analysis-local', enabled: true, contextWindow: 3726, maxTokens: 512 })
      await window.whomi.settings.selectModel('analysis', model.id)
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await app.close()
    await launch()
    await resize(1280)
    await openConversation()
    const start = page.getByRole('button', { name: '生成记忆', exact: true })
    await expect(start).toBeEnabled()
    await screenshot('01-confirm-desktop')
    await resize(360)
    await expect(start).toBeInViewport({ ratio: 1 })
    await screenshot('02-confirm-narrow')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    expect(await tasks()).toHaveLength(0)
    await resize(1280)
    await page.getByRole('button', { name: '整理成记忆', exact: true }).click()
    await start.click()
    await expect.poll(() => batches.length, { timeout: 30000 }).toBe(2)
    const [running] = await tasks()
    expect(running.analyzedMessages).toBe(batches[0].length)
    expect(running.analyzedMessages).toBe(8)
    expect(running.analyzedMessages).toBeLessThan(total)
    await screenshot('03-running')
    await page.getByRole('button', { name: '暂停生成', exact: true }).click()
    await expect.poll(async () => (await tasks())[0].state).toBe('stopped')
    const interruptedBatch = batches[1]
    await screenshot('04-paused')
    await app.close()
    holdSecondBatch = false
    await launch()
    await resize(1280)
    await openConversation()
    const resume = page.getByRole('button', { name: '继续生成', exact: true })
    await expect(resume).toBeEnabled()
    expect(await tasks()).toMatchObject([{ id: running.id, state: 'stopped', analyzedMessages: running.analyzedMessages }])
    await expect(page.getByText(`已整理 ${running.analyzedMessages} / ${total} 条`, { exact: true })).toBeVisible()
    await resize(360)
    await expect(resume).toBeInViewport({ ratio: 1 })
    await resume.focus()
    await expect(resume).toBeFocused()
    await screenshot('05-restored-narrow')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await tasks())[0].state, { timeout: 30000 }).toBe('failed')
    await expect(resume).toBeEnabled()
    await screenshot('06-failed-narrow')
    await resume.click()
    await expect.poll(async () => (await tasks())[0].state, { timeout: 30000 }).toBe('completed')
    expect(await tasks()).toMatchObject([{ id: running.id, state: 'completed', analyzedMessages: total }])
    expect(batches[2]).toEqual(interruptedBatch)
    const handled = [...batches[0], ...batches.slice(2).flat()]
    expect(handled.sort()).toEqual(Array.from({ length: total }, (_, i) => String(i + 1).padStart(2, '0')))
    await resize(1280)
    const report = page.getByRole('button', { name: '查看记忆', exact: true })
    await expect(report).toBeEnabled()
    await screenshot('06-completed')
    await report.click()
    await expect(page.getByText(summary, { exact: true })).toBeVisible()
    const dialog = page.getByRole('dialog', { name: '我们的记忆' })
    await expect(dialog.locator('h3')).toHaveText(['MBTI 预测','我们的记忆','我们的关系'])
    await expect(dialog.locator('.memory-prediction')).toHaveText('????')
    await expect(dialog.getByText('暂难判断', { exact: true })).toHaveCount(4)
    await expect(dialog.locator('h4')).toHaveText([eventTitle])
    await expect(dialog.locator('.memory-scope')).toHaveCount(1)
    await screenshot('07-report-wide')
    await resize(360)
    await dialog.getByRole('heading', { name: '我们的关系' }).scrollIntoViewIfNeeded()
    await screenshot('08-report-narrow')
    await page.keyboard.press('Escape')
    await expect(page.locator('.memory-task-row')).toBeFocused()
    await resize(1280)
    await page.getByRole('button', { name: '个人总览', exact: true }).click()
    await page.getByRole('button', { name: '查看记忆', exact: true }).click()
    await expect(dialog.locator('h4')).toHaveText([eventTitle])
    await page.getByRole('button', { name: '关闭记忆' }).click()
    const resumedBatches = batches.slice(2)
    eventTitle = '搬家日的钥匙与货车'
    includeDirection = true
    await page.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('button', { name: '整理成记忆' }).click()
    await page.getByRole('button', { name: '重新生成' }).click()
    await page.getByRole('button', { name: '生成记忆', exact: true }).click()
    await expect(report).toBeEnabled({ timeout: 30000 })
    await report.click()
    await expect(dialog.locator('h4')).toHaveText([eventTitle])
    await expect(dialog.locator('.memory-prediction')).toHaveText('????')
    await expect(dialog.getByText('暂难判断', { exact: true })).toHaveCount(4)
    await page.keyboard.press('Escape')
    const rows = page.locator('.memory-task-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toBeFocused()
    await screenshot('09-library-two')
    await rows.last().click()
    await expect(dialog.locator('h4')).toHaveText(['周六搬家'])
    await page.keyboard.press('Escape')
    await expect(rows.last()).toBeFocused()
    await page.getByRole('button', { name: '个人总览', exact: true }).click()
    const observations = page.getByRole('region', { name: '你在不同关系中的表现' })
    await expect(observations).toHaveCount(0)
    await screenshot('10-overview')
    await page.getByRole('button', { name: '查看记忆', exact: true }).click()
    await expect(dialog.locator('h4')).toHaveText([eventTitle])
    await page.keyboard.press('Escape')
    await page.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('button', { name: '选择本人', exact: true }).click()
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await identity.locator('label', { hasText: '朋友' }).click()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await expect(identity).toHaveCount(0)
    await page.getByRole('button', { name: '个人总览', exact: true }).click()
    await expect(observations).toHaveCount(0)
    await page.getByRole('button', { name: '记忆仓库', exact: true }).click()
    await expect(rows).toHaveCount(2)
    await rows.first().click()
    await expect(dialog.locator('h4')).toHaveText([eventTitle])
    await writeFile(join(evidence, 'checkpoint.json'), JSON.stringify({
      taskId: running.id,
      sourceMessages: total,
      savedBeforePause: running.analyzedMessages,
      firstAttempt: batches.slice(0, 2),
      requestsAfterRestart: resumedBatches,
      separateGeneration: batches.slice(2 + resumedBatches.length),
      completed: await tasks(),
    }, null, 2))
  } finally {
    server.closeAllConnections()
    await app?.close()
    await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
