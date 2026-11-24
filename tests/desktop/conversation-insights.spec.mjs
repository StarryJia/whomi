import { test, expect, _electron as electron } from '@playwright/test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mockReadAction, suggestionReport, syntheticInsightReportTitle, syntheticInsightScope } from './fixtures/insight-model.mjs'
import { completeModel } from './fixtures/pi-insight-model.mjs'

function replyForScope(messages) {
  const reply = suggestionReport()
  const includesLaterReply = messages.some(message => message.id === '4')
  Object.assign(reply.judgments.find(item => item.dimension === 'TF'), includesLaterReply
    ? { direction: 'F', text: '你这一次先回应了 ta 想被倾听的需要。', supportingIds: ['4'] }
    : { direction: 'T', text: '你起初先给出了解决办法。' })
  if (includesLaterReply) {
    reply.aboutYou.push({ content: [{ text: '你先听 ta 讲完', citationId: 'later-listening' }] })
    reply.citations.push({ id: 'later-listening', fragments: [{ messageIds: ['4'] }] })
  }
  return reply
}

test('空库导入后保留一份报告与另一项暂停任务，重启回查原文、续跑并重评总览', async ({}, testInfo) => {
  test.setTimeout(120_000)
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
        const prompt = mockReadAction(input)
        requests.push({ input, prompt, authorization: request.headers.authorization })
        if (prompt.action === 'report' && !interruptedCheck) {
          interruptedCheck = true
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.flushHeaders()
          return
        }
        if (prompt.action === 'report' && !rejectedWriting) {
          rejectedWriting = true
          response.writeHead(500, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'Synthetic retry fixture', type: 'server_error' } }))
          return
        }
        completeModel(response, prompt.read ? { read: prompt.read } : { text: JSON.stringify(replyForScope(prompt.messages)) })
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
    const file = resolve('tests/fixtures/insights/fresh-conversation.json')
    const { messages } = JSON.parse(await readFile(file, 'utf8'))
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
      await expect.poll(() => requests.map(request => request.prompt.action), { timeout: 15_000 }).toEqual(['open', 'check-source', 'report'])
    } catch (error) {
      const timeline = {
        confirmStartedAt, confirmedAt, timedOutAt: Date.now(),
        requestArrivals: requestArrivals.map(arrival => ({ ...arrival })),
        parsedStages: requests.map(request => request.prompt.action), fixtureErrorCount: fixtureErrors.length,
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
    expect(requests.filter(request => request.prompt.action === 'open')).toHaveLength(1)
    expect(requests[1].prompt.messages.map(message => message.id)).toEqual(['1', '2', '3'])
    expect(requests[1].prompt.messages[2].replyToMessageId).toBe('1')
    for (const message of messages.slice(3)) expect(JSON.stringify(requests)).not.toContain(message.content)
    expect(requests.every(request => request.authorization === 'Bearer test-only-key')).toBe(true)
    expect(requests.every(request => request.input.tools?.length === 1 && request.input.tools[0].function.name === 'read_messages')).toBe(true)
    expect(fixtureErrors).toEqual([])

    const savedReport = await page.evaluate(async id => (await window.whomi.ai.getAnalysis(id)).report, task.id)
    const report = await page.evaluate(id => window.whomi.ai.getReport(id), task.id)
    expect(report.format).toBe('conversation-insights-v1')
    const thinking = report.judgments.find(item => item.dimension === 'TF')
    expect(thinking).toMatchObject({
      direction: 'T',
      supportingSources: [{ messageId: '1', revision: expect.any(String) }],
      counterexampleSources: [{ messageId: '3', revision: expect.any(String) }],
    })
    for (const [fragmentIndex, id] of ['1', '3'].entries()) {
      const window = await page.evaluate(({ taskId, fragmentIndex }) => window.whomi.ai.readInsightCitation({
        taskId, citationId: 'suggestion-shift', fragmentIndex,
      }), { taskId: task.id, fragmentIndex })
      expect(window).toMatchObject({ status: 'available', startMessageId: id, endMessageId: id, highlightIds: [id] })
      expect(window.page.items.find(message => message.id === id)?.text).toBe(messages[Number(id) - 1].content)
    }
    const renamed = await page.evaluate(({ taskId, title }) => window.whomi.ai.renameAnalysis({ taskId, title }), {
      taskId: task.id, title: syntheticInsightReportTitle,
    })
    expect(renamed).toMatchObject({ title: syntheticInsightReportTitle, scope: syntheticInsightScope, report: savedReport })
    expect(await page.evaluate(id => window.whomi.ai.getReport(id), task.id)).toEqual(report)
    interruptedCheck = false
    const secondStart = requests.length
    const second = await page.evaluate(async ({ conversationId, modelId }) => {
      const prepared = await window.whomi.ai.prepareAnalysis({ conversationId, modelId, scope: { kind: 'all' } })
      return window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId: 'all-after-date-report' })
    }, task)
    expect(second.id).not.toBe(task.id)
    const secondStages = () => requests.slice(secondStart).map(request => request.prompt.action)
    await expect.poll(secondStages, { timeout: 15_000 }).toEqual(['open', 'check-source', 'report'])
    const stopped = await page.evaluate(id => window.whomi.ai.stopAnalysis(id), second.id)
    expect(stopped).toMatchObject({ state: 'stopped', analyzedMessages: 12 })
    const allInput = requests[secondStart + 1].prompt.messages
    expect(allInput.map(message => message.text)).toEqual(messages.slice(0, 12).map(message => message.content))
    expect(allInput[3]).toMatchObject({ isSelf: true, replyToMessageId: '3' })
    expect(allInput[5]).toMatchObject({ isSelf: false, replyToMessageId: '5' })

    await restart()
    expect(await page.evaluate(id => window.whomi.ai.getAnalysis(id), second.id)).toMatchObject({
      state: 'stopped', analyzedMessages: 12, elapsedMs: stopped.elapsedMs,
    })
    await button('对话洞察').click()
    await page.getByRole('button', { name: new RegExp(syntheticInsightReportTitle + ' #' + task.id) }).click()
    await button('你一开始就给了三个办法').click()
    const citation = page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')
    await expect(citation.getByText(messages[0].content, { exact: true })).toBeVisible()
    await testInfo.attach('重启后回查导入原文', { body: await page.screenshot(), contentType: 'image/png' })
    await button('关闭原文').click()
    await button('个人总览').click()
    const observations = page.getByRole('region', { name: '你在不同关系中的表现' })
    const firstSource = observations.getByRole('button', { name: `${syntheticInsightReportTitle} #${task.id}`, exact: true })
    const secondSource = observations.getByRole('button', { name: `会话洞察 #${second.id}`, exact: true })
    await expect(firstSource).toBeVisible()
    await expect(secondSource).toHaveCount(0)
    await expect(observations.getByText('??T?', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      window.syntheticInsightEvents = []
      window.whomi.ai.onEvent(event => window.syntheticInsightEvents.push(event))
    })
    await page.evaluate(id => window.whomi.ai.continueAnalysis(id), second.id)
    await expect(secondSource).toBeVisible({ timeout: 15_000 })
    await expect(observations.getByText('????', { exact: true })).toBeVisible()
    const saved = await page.evaluate(id => window.whomi.ai.getAnalysis(id), second.id)
    expect(saved).toMatchObject({ id: second.id, state: 'completed', scope: { kind: 'all' }, totalMessages: 12, analyzedMessages: 12 })
    const feeling = saved.report.judgments.find(item => item.dimension === 'TF')
    expect(feeling).toMatchObject({ direction: 'F', supportingSources: [{ messageId: '4', revision: expect.any(String) }] })
    expect(feeling.counterexampleSources).toEqual(savedReport.judgments.find(item => item.dimension === 'TF').counterexampleSources)
    expect(saved.report.citations.find(item => item.id === 'later-listening').fragments[0].sources)
      .toEqual(feeling.supportingSources)
    await expect.poll(() => page.evaluate(() => window.syntheticInsightEvents)).toContainEqual({
      kind: 'analysis', snapshot: expect.objectContaining({
        id: saved.id, state: 'completed', scope: saved.scope, totalMessages: saved.totalMessages,
        analyzedMessages: saved.analyzedMessages, eventSequence: saved.eventSequence, report: saved.report,
      }),
    })
    const resumedStages = secondStages().slice(3)
    expect(resumedStages.length).toBeGreaterThan(0)
    expect(resumedStages).not.toContain('open')
    expect(resumedStages.at(-1)).toBe('report')
    const requestsAtCompletion = requests.length
    await testInfo.attach('两份报告方向冲突', { body: await page.screenshot(), contentType: 'image/png' })
    await page.evaluate(id => window.whomi.ai.deleteAnalysis(id), task.id)
    await expect.poll(() => page.evaluate(() => window.syntheticInsightEvents)).toContainEqual({
      kind: 'analysis-deleted', taskId: task.id, conversationId: conversation.id,
    })
    await expect(firstSource).toHaveCount(0)
    await expect(secondSource).toBeVisible()
    await expect(observations.getByText('??F?', { exact: true })).toBeVisible()
    await secondSource.click()
    await button('你先听 ta 讲完').click()
    await expect(citation.getByText(messages[3].content, { exact: true })).toBeVisible()
    expect((await page.evaluate(id => window.whomi.ai.listAnalyses(id), conversation.id)).map(item => item.id)).toEqual([second.id])
    expect(await page.evaluate(taskId => window.whomi.ai.readInsightCitation({ taskId, citationId: 'suggestion-shift', fragmentIndex: 0 }), task.id))
      .toEqual({ status: 'unavailable' })
    const preserved = await page.evaluate(conversationId => window.whomi.readMessages({ conversationId, direction: 'before', limit: 20 }), conversation.id)
    expect(preserved.items.map(message => message.text)).toEqual(messages.slice(0, 12).map(message => message.content))

    await page.evaluate(async ({ conversationId, modelId }) => {
      await window.whomi.confirmSelf(conversationId, null)
      await window.whomi.settings.removeModel(modelId)
    }, task)
    await restart()
    const members = await page.evaluate(id => window.whomi.listMembers(id), conversation.id)
    expect(members.some(member => member.confirmedSelf)).toBe(false)
    const models = await page.evaluate(() => window.whomi.ai.listModels())
    expect(models.filter(model => model.enabled)).toHaveLength(0)
    await button('对话洞察').click()
    await page.getByRole('button', { name: new RegExp('会话洞察 #' + second.id + '$') }).click()
    await button('你先听 ta 讲完').click()
    const reopened = page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')
    await expect(reopened.getByText(messages[3].content, { exact: true })).toBeVisible()
    await testInfo.attach('缺少本人和模型时回查已存报告', { body: await page.screenshot(), contentType: 'image/png' })
    expect(requests).toHaveLength(requestsAtCompletion)
    expect(fixtureErrors).toEqual([])
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
