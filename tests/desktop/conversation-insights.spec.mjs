import { test, expect, _electron as electron } from '@playwright/test'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { insightModelPrompt, insightModelReply, syntheticInsightConversation, syntheticInsightMessages, syntheticInsightReportTitle, syntheticInsightScope } from './fixtures/insight-model.mjs'

function writeCompletion(response, result) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ id: 'synthetic-insight', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
  response.end(`data: ${JSON.stringify({ id: 'synthetic-insight', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
}

test('从空库导入聊天并确认本人，按日期生成洞察、暂停和重试，重启后从报告回查原文', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-insight-')))
  const requests = []
  const requestArrivals = []
  const fixtureErrors = []
  let interruptedCheck = false, rejectedWriting = false
  const server = createServer((request, response) => {
    const arrival = { receivedAt: Date.now(), bodyReceivedAt: null }
    requestArrivals.push(arrival)
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      arrival.bodyReceivedAt = Date.now()
      try {
        const input = JSON.parse(body)
        const prompt = insightModelPrompt(input)
        requests.push({ input, prompt, authorization: request.headers.authorization })
        if (prompt.stage === 'checking' && !interruptedCheck) {
          interruptedCheck = true
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.flushHeaders()
          return
        }
        if (prompt.stage === 'writing' && !rejectedWriting) {
          rejectedWriting = true
          response.writeHead(500, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'Synthetic retry fixture', type: 'server_error' } }))
          return
        }
        writeCompletion(response, insightModelReply(prompt))
      } catch (error) {
        fixtureErrors.push(String(error))
        response.end()
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let application, page
  const button = name => page.getByRole('button', { name, exact: true })
  try {
    const members = [{ platformId: 'self', accountName: '合成本人' }, { platformId: 'peer', accountName: '合成对方' }]
    const file = join(directory, 'conversation.json')
    await writeFile(file, JSON.stringify({
      chatlab: { version: '0.0.2' },
      meta: { name: syntheticInsightConversation, platform: 'discord', type: 'direct', groupId: 'insight-test', ownerId: 'self' },
      members,
      messages: syntheticInsightMessages.map(({ id, member, at, text }) => ({
        sender: members[member - 1].platformId, accountName: members[member - 1].accountName, type: 0,
        timestamp: at / 1000, content: text, platformMessageId: id, ...(id === '3' ? { replyToMessageId: '1' } : {}),
      })),
    }))
    await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
    async function launch() {
      application = await electron.launch({
        args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
        env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
      })
      page = await application.firstWindow()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(page.locator('.hello-cover')).toBeAttached({ timeout: 15_000 })
      await expect(page.locator('.startup-intro')).toHaveCount(0)
    }
    async function restart() {
      await application.close()
      await launch()
    }
    await launch()
    expect((await page.evaluate(() => window.whomi.listConversations({}))).items).toEqual([])
    expect(await page.evaluate(() => window.whomi.ai.listAnalyses())).toEqual([])
    await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '合成本地服务', baseUrl, enabled: true, apiKey: 'test-only-key' })
      await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成洞察模型', model: 'example', contextWindow: 12000, maxTokens: 1000, enabled: true })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await restart()
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setTimezoneOverride', { timezoneId: syntheticInsightScope.timezone })
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)
    await button('导入会话').click()
    await button('选择文件').click()
    await button('打开会话').click()
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await identity.getByRole('radio', { name: /合成本人/ }).check()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await expect(identity).toHaveCount(0)
    const { items: [conversation] } = await page.evaluate(() => window.whomi.listConversations({}))
    const preview = await page.evaluate(input => window.whomi.ai.previewInsightScope(input), { conversationId: conversation.id, scope: syntheticInsightScope })
    expect(preview).toMatchObject({ scope: syntheticInsightScope, totalMessages: 3, analyzableMessages: 3 })
    await button('会话洞察').click()
    await page.getByRole('combobox', { name: '分析模型' }).click()
    await page.getByRole('option', { name: /合成洞察模型/ }).click()
    await page.getByRole('radio', { name: '日期范围' }).check()
    await page.getByLabel('开始日期', { exact: true }).fill(syntheticInsightScope.startDate)
    await page.getByLabel('结束日期', { exact: true }).fill(syntheticInsightScope.endDate)
    await expect(page.getByRole('group', { name: '范围' }).getByText('3 条消息')).toBeVisible()
    await expect(button('开始洞察')).toBeEnabled()
    await page.evaluate(() => {
      window.syntheticInsightStarted = []
      window.whomi.ai.onEvent(event => {
        if (event.kind !== 'analysis') return
        const { state, analyzedMessages, eventSequence } = event.snapshot
        window.syntheticInsightStarted.push({ receivedAt: Date.now(), state, analyzedMessages, eventSequence })
      })
    })
    expect(requests).toHaveLength(0)
    const confirmStartedAt = Date.now()
    await button('开始洞察').click()
    const confirmedAt = Date.now()
    await expect.poll(() => page.evaluate(() => window.whomi.ai.listAnalyses())).toHaveLength(1)
    const [task] = await page.evaluate(() => window.whomi.ai.listAnalyses())
    expect(task).toMatchObject({ title: '会话洞察', conversationId: conversation.id, totalMessages: 3, scope: syntheticInsightScope })
    try {
      await expect.poll(() => requests.map(request => request.prompt.stage), { timeout: 15_000 }).toEqual(['reading', 'checking'])
    } catch (error) {
      const timeline = {
        confirmStartedAt, confirmedAt, timedOutAt: Date.now(),
        requestArrivals: requestArrivals.map(arrival => ({ ...arrival })),
        parsedStages: requests.map(request => request.prompt.stage), fixtureErrorCount: fixtureErrors.length,
      }
      const [renderer, screenshot] = await Promise.allSettled([
        Promise.race([page.evaluate(async id => {
          const events = [...window.syntheticInsightStarted]
          const current = await window.whomi.ai.getAnalysis(id).catch(() => null)
          return { events, task: current && { state: current.state, analyzedMessages: current.analyzedMessages,
            elapsedMs: current.elapsedMs, usageIncomplete: current.usage.incomplete, error: current.error } }
        }, task.id), delay(2_000, null, { ref: false })]),
        page.screenshot({ timeout: 2_000 }),
      ])
      await testInfo.attach('first-model-request-timeout', { contentType: 'application/json', body: JSON.stringify({
        ...timeline, renderer: renderer.status === 'fulfilled' ? renderer.value : null,
        screenshotCaptured: screenshot.status === 'fulfilled',
      }, null, 2) })
      if (screenshot.status === 'fulfilled') {
        await testInfo.attach('first-model-request-window', { contentType: 'image/png', body: screenshot.value })
      }
      throw error
    }
    const paused = await page.evaluate(id => window.whomi.ai.stopAnalysis(id), task.id)
    expect(paused).toMatchObject({ state: 'stopped', analyzedMessages: 3 })
    await expect(page.evaluate(id => window.whomi.ai.getReport(id), task.id)).rejects.toThrow()

    await restart()
    expect(await page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id)).toMatchObject({
      state: 'stopped', elapsedMs: paused.elapsedMs, analyzedMessages: 3,
    })
    await page.evaluate(id => window.whomi.ai.continueAnalysis(id), task.id)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 15_000 })
      .toMatchObject({ state: 'failed', analyzedMessages: 3 })
    await expect(page.evaluate(id => window.whomi.ai.getReport(id), task.id)).rejects.toThrow()
    await page.evaluate(id => window.whomi.ai.continueAnalysis(id), task.id)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 15_000 })
      .toMatchObject({ state: 'completed', analyzedMessages: 3, title: '会话洞察' })
    expect(requests.map(request => request.prompt.stage)).toEqual(['reading', 'checking', 'checking', 'checking', 'writing', 'writing'])
    expect(requests.filter(request => request.prompt.stage === 'checking').map(request => request.prompt.check.round)).toEqual([1, 2, 3])
    expect(requests[0].prompt.messages.map(message => message.id)).toEqual(['1', '2', '3'])
    expect(requests[0].prompt.messages[2].replyToMessageId).toBe('1')
    expect(JSON.stringify(requests)).not.toContain(syntheticInsightMessages[3].text)
    expect(requests.every(request => request.authorization === 'Bearer test-only-key')).toBe(true)
    expect(requests.every(request => !(request.input.tools?.length))).toBe(true)
    expect(fixtureErrors).toEqual([])

    const report = await page.evaluate(id => window.whomi.ai.getReport(id), task.id)
    expect(report).toMatchObject({
      format: 'conversation-insights-v1',
      judgments: [{
        dimension: 'TF', direction: null,
        supportingSources: [{ messageId: '1', revision: expect.any(String) }],
        counterexampleSources: [{ messageId: '3', revision: expect.any(String) }],
      }],
    })
    for (const [fragmentIndex, id] of ['1', '3'].entries()) {
      const window = await page.evaluate(({ taskId, fragmentIndex }) => window.whomi.ai.readInsightCitation({
        taskId, citationId: 'suggestion-shift', fragmentIndex,
      }), { taskId: task.id, fragmentIndex })
      expect(window).toMatchObject({ status: 'available', startMessageId: id, endMessageId: id, highlightIds: [id] })
      expect(window.page.items.find(message => message.id === id)?.text).toBe(syntheticInsightMessages[Number(id) - 1].text)
    }
    const renamed = await page.evaluate(({ taskId, title }) => window.whomi.ai.renameAnalysis({ taskId, title }), {
      taskId: task.id, title: syntheticInsightReportTitle,
    })
    expect(renamed).toMatchObject({ title: syntheticInsightReportTitle, scope: syntheticInsightScope, report })
    await restart()
    await button('对话洞察').click()
    await page.getByRole('button', { name: new RegExp(syntheticInsightReportTitle + ' #' + task.id) }).click()
    await button('你一开始就给了三个办法').click()
    const citation = page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')
    await expect(citation.getByText(syntheticInsightMessages[0].text, { exact: true })).toBeVisible()
    await testInfo.attach('重启后回查导入原文', { body: await page.screenshot(), contentType: 'image/png' })
    await page.evaluate(() => {
      window.syntheticInsightEvents = []
      window.whomi.ai.onEvent(event => window.syntheticInsightEvents.push(event))
    })
    await page.evaluate(id => window.whomi.ai.deleteAnalysis(id), task.id)
    await expect.poll(() => page.evaluate(() => window.syntheticInsightEvents)).toContainEqual({
      kind: 'analysis-deleted', taskId: task.id, conversationId: conversation.id,
    })
    expect(await page.evaluate(id => window.whomi.ai.listAnalyses(id), conversation.id)).toEqual([])
    expect(await page.evaluate(taskId => window.whomi.ai.readInsightCitation({ taskId, citationId: 'suggestion-shift', fragmentIndex: 0 }), task.id))
      .toEqual({ status: 'unavailable' })
    const preserved = await page.evaluate(conversationId => window.whomi.readMessages({ conversationId, direction: 'before', limit: 10 }), conversation.id)
    expect(preserved.items.map(message => message.text)).toEqual(syntheticInsightMessages.map(message => message.text))
    expect(requests).toHaveLength(6)
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('failure.png'), timeout: 3000 }).catch(() => {})
    for (const name of ['logs', 'Crashpad']) {
      await cp(join(directory, name), testInfo.outputPath(name), { recursive: true })
        .catch(cause => { if (cause.code !== 'ENOENT') console.warn('Could not copy ' + name, cause) })
    }
    throw error
  } finally {
    await application?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (dirname(directory) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
