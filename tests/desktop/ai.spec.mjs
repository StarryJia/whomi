import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('real Pi process persists analysis reports and dialogue through the isolated desktop bridge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  const evidence = resolve('release/cherry-conversation-20261031')
  await mkdir(evidence, { recursive: true })
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const input = JSON.parse(body); requests.push({ input, authorization: request.headers.authorization })
      const analysis = JSON.stringify(input.messages[0]).includes('你负责对某段会话')
      const text = analysis ? JSON.stringify({ summary: '示例任务总结', observations: [{ text: '提供具体帮助', evidenceMessageIds: ['1'], limitations: '仅限示例记录' }], limitations: '这不是人格诊断' }) : '这段示例中，你约定了一个明确的时间。'
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let application
  try {
    await writeFile(join(directory, 'probe.cjs'), `module.exports=(writer)=>async method=>{
      if(method!=='probe.aiSeed')throw Error('Unsupported');
      writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'虚构会话','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
      INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','明晚九点我听你讲',0);\`);
      return true;
    }`)
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    let page = await application.firstWindow()
    await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.aiSeed', null))
    const port = server.address().port
    const model = await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '合成本地服务', baseUrl, enabled: true, apiKey: 'test-only-key' })
      const saved = await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成本地模型', model: 'example', contextWindow: 8000, maxTokens: 1000, enabled: true })
      await window.whomi.settings.selectModel('conversation', saved.id)
      await window.whomi.settings.selectModel('analysis', saved.id)
      return saved
    }, `http://127.0.0.1:${port}/v1`)
    expect(model).toMatchObject({ version: 1, hasCredential: true })
    expect(model.apiKey).toBeUndefined()
    await application.close()
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await application.firstWindow()
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('button', { name: '虚构会话', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '对话模型' })).toHaveAttribute('title', '合成本地模型 | 合成本地服务')
    await page.getByRole('combobox', { name: '对话模型' }).click()
    await expect(page.getByRole('group', { name: '合成本地服务' })).toBeVisible()
    await page.screenshot({ path: join(evidence, '01-model-selector.png') })
    await page.keyboard.press('Escape')
    const preparation = await page.evaluate(modelId => window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId }), model.id)
    expect(preparation).toMatchObject({ selfName: '本人', totalMessages: 1, analyzableMessages: 1 })
    expect(requests).toHaveLength(0)
    const task = await page.evaluate(token => window.whomi.ai.confirmAnalysis({ token, requestId: 'analysis-one' }), preparation.token)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 30000 }).toMatchObject({ state: 'completed', analyzedMessages: 1, usage: { inputTokens: 40, outputTokens: 20 } })
    expect(await page.evaluate(id => window.whomi.ai.getReport(id), task.id)).toMatchObject({ summary: '示例任务总结' })
    const thread = await page.evaluate(() => window.whomi.ai.openThread('1'))
    await page.getByRole('button', { name: '选择消息', exact: true }).click()
    await page.getByRole('option', { name: '本人：明晚九点我听你讲' }).click()
    await page.getByRole('textbox').fill('我做了什么？')
    await page.getByRole('button', { name: '发送给 AI' }).click()
    await expect(page.getByRole('textbox', { name: '向 AI 提问' })).toHaveValue('')
    await expect(page.getByText('这段示例中，你约定了一个明确的时间。', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => (await page.evaluate(id => window.whomi.ai.getThread(id), thread.id)).turns[0], { timeout: 30000 }).toMatchObject({ state: 'completed', referenceIds: ['1'], usage: { inputTokens: 20, outputTokens: 10 } })
    await expect(page.getByText('在右侧继续对话', { exact: true })).toHaveCount(0)
    await expect(page.locator('.conversation-ai-header')).not.toContainText('虚构会话')
    await page.screenshot({ path: join(evidence, '02-conversation.png') })
    await page.locator('.conversation-usage button').click()
    await expect(page.getByRole('region', { name: '生成统计' })).toContainText('模型生成 TPS')
    await expect(page.getByRole('region', { name: '生成统计' })).toContainText('合成本地服务')
    await page.screenshot({ path: join(evidence, '03-token-statistics.png') })
    await page.keyboard.press('Escape')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(574, 800))
    await expect(page.getByRole('textbox', { name: '向 AI 提问' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, '04-conversation-narrow.png') })
    expect(requests.every(value => value.authorization === 'Bearer test-only-key')).toBe(true)
    expect(requests.every(value => !(value.input.tools?.length))).toBe(true)
    await application.close()
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const restarted = await application.firstWindow()
    expect((await restarted.evaluate(id => window.whomi.ai.getThread(id), thread.id)).turns).toHaveLength(1)
    expect(await restarted.evaluate(id => window.whomi.ai.getReport(id), task.id)).toMatchObject({ summary: '示例任务总结' })
  } finally {
    await application?.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
