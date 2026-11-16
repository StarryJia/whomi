import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { insightModelPrompt, insightModelReply, syntheticInsightMessages, syntheticInsightReportTitle, syntheticInsightScope } from './fixtures/insight-model.mjs'

function writeCompletion(response, result) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ id: 'synthetic-insight', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
  response.end(`data: ${JSON.stringify({ id: 'synthetic-insight', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
}

test('isolated Electron resumes a scoped insight, retries writing, and preserves exact citations through rename and deletion', async () => {
  test.setTimeout(60_000)
  const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-insight-')))
  const requests = []
  const fixtureErrors = []
  let interruptedCheck = false, rejectedWriting = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
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
  let application
  try {
    const fixture = await readFile(new URL('./fixtures/insight-model.mjs', import.meta.url), 'utf8')
    await writeFile(join(directory, 'insight-model.mjs'), fixture)
    await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => async method => {
      if (method !== 'probe.seedInsight') throw new Error('Unsupported synthetic probe')
      const { seedSyntheticInsight } = await import('./insight-model.mjs')
      return writer.transaction(() => seedSyntheticInsight(writer))()
    }`)
    const launch = () => electron.launch({
      args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    application = await launch()
    let page = await application.firstWindow()
    await application.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seedInsight', null))
    const model = await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '合成本地服务', baseUrl, enabled: true, apiKey: 'test-only-key' })
      return window.whomi.settings.saveModel({ providerId: provider.id, label: '合成洞察模型', model: 'example', contextWindow: 12000, maxTokens: 1000, enabled: true })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    const preview = await page.evaluate(scope => window.whomi.ai.previewInsightScope({ conversationId: '1', scope }), syntheticInsightScope)
    expect(preview).toMatchObject({ scope: syntheticInsightScope, totalMessages: 3, analyzableMessages: 3 })
    await page.evaluate(async ({ modelId, scope }) => {
      window.syntheticInsightEvents = []
      window.whomi.ai.onEvent(event => window.syntheticInsightEvents.push(event))
      window.syntheticInsightPreparation = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId, scope })
    }, { modelId: model.id, scope: syntheticInsightScope })
    expect(requests).toHaveLength(0)
    const task = await page.evaluate(() => window.whomi.ai.confirmAnalysis({ token: window.syntheticInsightPreparation.token, requestId: 'synthetic-insight' }))
    expect(task).toMatchObject({ title: '会话洞察', totalMessages: 3, scope: syntheticInsightScope })
    await expect.poll(() => requests.map(request => request.prompt.stage), { timeout: 15_000 }).toEqual(['reading', 'checking'])
    const paused = await page.evaluate(id => window.whomi.ai.stopAnalysis(id), task.id)
    expect(paused).toMatchObject({ state: 'stopped', analyzedMessages: 3 })
    await expect(page.evaluate(id => window.whomi.ai.getReport(id), task.id)).rejects.toThrow()

    await application.close()
    application = await launch()
    page = await application.firstWindow()
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
    await page.evaluate(() => {
      window.syntheticInsightEvents = []
      window.whomi.ai.onEvent(event => window.syntheticInsightEvents.push(event))
    })
    await page.evaluate(id => window.whomi.ai.deleteAnalysis(id), task.id)
    await expect.poll(() => page.evaluate(() => window.syntheticInsightEvents)).toContainEqual({
      kind: 'analysis-deleted', taskId: task.id, conversationId: '1',
    })
    expect(await page.evaluate(() => window.whomi.ai.listAnalyses('1'))).toEqual([])
    expect(await page.evaluate(taskId => window.whomi.ai.readInsightCitation({ taskId, citationId: 'suggestion-shift', fragmentIndex: 0 }), task.id))
      .toEqual({ status: 'unavailable' })
    const preserved = await page.evaluate(() => window.whomi.readMessages({ conversationId: '1', direction: 'before', limit: 10 }))
    expect(preserved.items.map(message => message.text)).toEqual(syntheticInsightMessages.map(message => message.text))
    expect(requests).toHaveLength(6)
  } finally {
    await application?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (dirname(directory) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
