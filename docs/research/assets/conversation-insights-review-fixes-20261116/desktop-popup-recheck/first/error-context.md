# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests\desktop\conversation-insights.spec.mjs >> isolated Electron resumes a scoped insight, retries writing, and preserves exact citations through rename and deletion
- Location: tests\desktop\conversation-insights.spec.mjs:14:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 4
+ Received  + 1

- Array [
-   "reading",
-   "checking",
- ]
+ Array []

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Test source

```ts
  1   | import { test, expect, _electron as electron } from '@playwright/test'
  2   | import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
  3   | import { createServer } from 'node:http'
  4   | import { tmpdir } from 'node:os'
  5   | import { dirname, join, resolve } from 'node:path'
  6   | import { insightModelPrompt, insightModelReply, syntheticInsightMessages, syntheticInsightReportTitle, syntheticInsightScope } from './fixtures/insight-model.mjs'
  7   |
  8   | function writeCompletion(response, result) {
  9   |   response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  10  |   response.write(`data: ${JSON.stringify({ id: 'synthetic-insight', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
  11  |   response.end(`data: ${JSON.stringify({ id: 'synthetic-insight', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
  12  | }
  13  |
  14  | test('isolated Electron resumes a scoped insight, retries writing, and preserves exact citations through rename and deletion', async () => {
  15  |   test.setTimeout(60_000)
  16  |   const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-insight-')))
  17  |   const requests = []
  18  |   const fixtureErrors = []
  19  |   let interruptedCheck = false, rejectedWriting = false
  20  |   const server = createServer((request, response) => {
  21  |     let body = ''
  22  |     request.on('data', chunk => { body += chunk })
  23  |     request.on('end', () => {
  24  |       try {
  25  |         const input = JSON.parse(body)
  26  |         const prompt = insightModelPrompt(input)
  27  |         requests.push({ input, prompt, authorization: request.headers.authorization })
  28  |         if (prompt.stage === 'checking' && !interruptedCheck) {
  29  |           interruptedCheck = true
  30  |           response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  31  |           response.flushHeaders()
  32  |           return
  33  |         }
  34  |         if (prompt.stage === 'writing' && !rejectedWriting) {
  35  |           rejectedWriting = true
  36  |           response.writeHead(500, { 'Content-Type': 'application/json' })
  37  |           response.end(JSON.stringify({ error: { message: 'Synthetic retry fixture', type: 'server_error' } }))
  38  |           return
  39  |         }
  40  |         writeCompletion(response, insightModelReply(prompt))
  41  |       } catch (error) {
  42  |         fixtureErrors.push(String(error))
  43  |         response.end()
  44  |       }
  45  |     })
  46  |   })
  47  |   await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  48  |   let application
  49  |   try {
  50  |     const fixture = await readFile(new URL('./fixtures/insight-model.mjs', import.meta.url), 'utf8')
  51  |     await writeFile(join(directory, 'insight-model.mjs'), fixture)
  52  |     await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => async method => {
  53  |       if (method !== 'probe.seedInsight') throw new Error('Unsupported synthetic probe')
  54  |       const { seedSyntheticInsight } = await import('./insight-model.mjs')
  55  |       return writer.transaction(() => seedSyntheticInsight(writer))()
  56  |     }`)
  57  |     const launch = () => electron.launch({
  58  |       args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
  59  |       env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  60  |     })
  61  |     application = await launch()
  62  |     let page = await application.firstWindow()
  63  |     await application.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seedInsight', null))
  64  |     const model = await page.evaluate(async baseUrl => {
  65  |       const provider = await window.whomi.settings.saveProvider({ name: '合成本地服务', baseUrl, enabled: true, apiKey: 'test-only-key' })
  66  |       return window.whomi.settings.saveModel({ providerId: provider.id, label: '合成洞察模型', model: 'example', contextWindow: 12000, maxTokens: 1000, enabled: true })
  67  |     }, `http://127.0.0.1:${server.address().port}/v1`)
  68  |     const preview = await page.evaluate(scope => window.whomi.ai.previewInsightScope({ conversationId: '1', scope }), syntheticInsightScope)
  69  |     expect(preview).toMatchObject({ scope: syntheticInsightScope, totalMessages: 3, analyzableMessages: 3 })
  70  |     await page.evaluate(async ({ modelId, scope }) => {
  71  |       window.syntheticInsightEvents = []
  72  |       window.whomi.ai.onEvent(event => window.syntheticInsightEvents.push(event))
  73  |       window.syntheticInsightPreparation = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId, scope })
  74  |     }, { modelId: model.id, scope: syntheticInsightScope })
  75  |     expect(requests).toHaveLength(0)
  76  |     const task = await page.evaluate(() => window.whomi.ai.confirmAnalysis({ token: window.syntheticInsightPreparation.token, requestId: 'synthetic-insight' }))
  77  |     expect(task).toMatchObject({ title: '会话洞察', totalMessages: 3, scope: syntheticInsightScope })
> 78  |     await expect.poll(() => requests.map(request => request.prompt.stage), { timeout: 15_000 }).toEqual(['reading', 'checking'])
      |                                                                                                 ^ Error: expect(received).toEqual(expected) // deep equality
  79  |     const paused = await page.evaluate(id => window.whomi.ai.stopAnalysis(id), task.id)
  80  |     expect(paused).toMatchObject({ state: 'stopped', analyzedMessages: 3 })
  81  |     await expect(page.evaluate(id => window.whomi.ai.getReport(id), task.id)).rejects.toThrow()
  82  |
  83  |     await application.close()
  84  |     application = await launch()
  85  |     page = await application.firstWindow()
  86  |     expect(await page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id)).toMatchObject({
  87  |       state: 'stopped', elapsedMs: paused.elapsedMs, analyzedMessages: 3,
  88  |     })
  89  |     await page.evaluate(id => window.whomi.ai.continueAnalysis(id), task.id)
  90  |     await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 15_000 })
  91  |       .toMatchObject({ state: 'failed', analyzedMessages: 3 })
  92  |     await expect(page.evaluate(id => window.whomi.ai.getReport(id), task.id)).rejects.toThrow()
  93  |     await page.evaluate(id => window.whomi.ai.continueAnalysis(id), task.id)
  94  |     await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 15_000 })
  95  |       .toMatchObject({ state: 'completed', analyzedMessages: 3, title: '会话洞察' })
  96  |     expect(requests.map(request => request.prompt.stage)).toEqual(['reading', 'checking', 'checking', 'checking', 'writing', 'writing'])
  97  |     expect(requests.filter(request => request.prompt.stage === 'checking').map(request => request.prompt.check.round)).toEqual([1, 2, 3])
  98  |     expect(requests[0].prompt.messages.map(message => message.id)).toEqual(['1', '2', '3'])
  99  |     expect(requests[0].prompt.messages[2].replyToMessageId).toBe('1')
  100 |     expect(JSON.stringify(requests)).not.toContain(syntheticInsightMessages[3].text)
  101 |     expect(requests.every(request => request.authorization === 'Bearer test-only-key')).toBe(true)
  102 |     expect(requests.every(request => !(request.input.tools?.length))).toBe(true)
  103 |     expect(fixtureErrors).toEqual([])
  104 |
  105 |     const report = await page.evaluate(id => window.whomi.ai.getReport(id), task.id)
  106 |     expect(report).toMatchObject({
  107 |       format: 'conversation-insights-v1',
  108 |       judgments: [{
  109 |         dimension: 'TF', direction: null,
  110 |         supportingSources: [{ messageId: '1', revision: expect.any(String) }],
  111 |         counterexampleSources: [{ messageId: '3', revision: expect.any(String) }],
  112 |       }],
  113 |     })
  114 |     for (const [fragmentIndex, id] of ['1', '3'].entries()) {
  115 |       const window = await page.evaluate(({ taskId, fragmentIndex }) => window.whomi.ai.readInsightCitation({
  116 |         taskId, citationId: 'suggestion-shift', fragmentIndex,
  117 |       }), { taskId: task.id, fragmentIndex })
  118 |       expect(window).toMatchObject({ status: 'available', startMessageId: id, endMessageId: id, highlightIds: [id] })
  119 |       expect(window.page.items.find(message => message.id === id)?.text).toBe(syntheticInsightMessages[Number(id) - 1].text)
  120 |     }
  121 |     const renamed = await page.evaluate(({ taskId, title }) => window.whomi.ai.renameAnalysis({ taskId, title }), {
  122 |       taskId: task.id, title: syntheticInsightReportTitle,
  123 |     })
  124 |     expect(renamed).toMatchObject({ title: syntheticInsightReportTitle, scope: syntheticInsightScope, report })
  125 |     await page.evaluate(() => {
  126 |       window.syntheticInsightEvents = []
  127 |       window.whomi.ai.onEvent(event => window.syntheticInsightEvents.push(event))
  128 |     })
  129 |     await page.evaluate(id => window.whomi.ai.deleteAnalysis(id), task.id)
  130 |     await expect.poll(() => page.evaluate(() => window.syntheticInsightEvents)).toContainEqual({
  131 |       kind: 'analysis-deleted', taskId: task.id, conversationId: '1',
  132 |     })
  133 |     expect(await page.evaluate(() => window.whomi.ai.listAnalyses('1'))).toEqual([])
  134 |     expect(await page.evaluate(taskId => window.whomi.ai.readInsightCitation({ taskId, citationId: 'suggestion-shift', fragmentIndex: 0 }), task.id))
  135 |       .toEqual({ status: 'unavailable' })
  136 |     const preserved = await page.evaluate(() => window.whomi.readMessages({ conversationId: '1', direction: 'before', limit: 10 }))
  137 |     expect(preserved.items.map(message => message.text)).toEqual(syntheticInsightMessages.map(message => message.text))
  138 |     expect(requests).toHaveLength(6)
  139 |   } finally {
  140 |     await application?.close()
  141 |     server.closeAllConnections()
  142 |     await new Promise(resolve => server.close(resolve))
  143 |     if (dirname(directory) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  144 |   }
  145 | })
  146 |
```
