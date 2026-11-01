import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { memoryModelReply } from './fixtures/memory-model.mjs'

test('existing data and encrypted models survive the packaged upgrade and subsequent restart', async () => {
  test.skip(!process.env.WHOMI_OLD_EXECUTABLE || !process.env.WHOMI_PACKAGED_EXECUTABLE, '需要提供旧版与新版安装包中的可执行程序。')
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-upgrade-'))
  const version = JSON.parse(await readFile('package.json', 'utf8')).version
  const evidence = resolve(process.env.WHOMI_UPGRADE_EVIDENCE ?? `release/validation-${version}`)
  await mkdir(evidence, { recursive: true })
  const authorizations = []
  let pauseLegacy = false
  let legacyRequests = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const input = JSON.parse(body)
      authorizations.push(request.headers.authorization)
      const analysis = JSON.stringify(input.messages[0]).includes('你负责对某段会话')
      const manuscript = memoryModelReply(input.messages, { title: '升级前的经历', text: '升级前保存的示例文稿。' })
      if (pauseLegacy && (analysis || manuscript) && ++legacyRequests === 2) return
      const text = manuscript ?? (analysis ? JSON.stringify({ summary: '升级前的合成报告', observations: [{ text: '示例观察', evidenceMessageIds: ['1'], limitations: '虚构材料' }], limitations: '仅用于升级验收' }) : '升级验收合成回答')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'upgrade', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id: 'upgrade', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(directory, 'probe.cjs'), `module.exports=(writer,reader)=>async method=>{
    if(method==='probe.seed'){
      writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'升级验收 · 虚构会话','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','upgrade');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','示例甲');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
      INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','示例甲','text','升级前保存的消息，保留原文。',0);\`);return true;
    }
    if(method==='probe.snapshot'){
      const hash=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value,(_key,item)=>_key==='thinking_level' && item===null?undefined:typeof item==='bigint'?item.toString():item)).digest('hex');
      return Object.fromEntries(['conversations','source_conversations','memberships','self_confirmations','messages','ai_models','ai_model_versions','ai_reports','ai_turns'].map(table=>[table,hash(reader.prepare('SELECT '+(table==='conversations'?'id,title,kind,created_at_ms':'*')+' FROM '+table+' ORDER BY 1').all())]));
    }
    throw Error('Unsupported');
  }`)
  let app
  const launch = executablePath => electron.launch({ executablePath: resolve(executablePath), args: ['--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  try {
    app = await launch(process.env.WHOMI_OLD_EXECUTABLE)
    let page = await app.firstWindow()
    await expect(page.locator('main')).toBeVisible()
    const oldInfo = await app.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName() }))
    expect(['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8']).toContain(oldInfo.version)
    const oldMemory = ['0.1.6', '0.1.7', '0.1.8'].includes(oldInfo.version)
    const originalReport = oldMemory ? { format: oldInfo.version === '0.1.6' ? 'memory-v2' : 'memory-v3', events: [{ title: '升级前的经历' }] } : { summary: '升级前的合成报告' }
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.seed', null))
    const model = await page.evaluate(async baseUrl => {
      if (window.whomi.settings) {
        const provider = await window.whomi.settings.saveProvider({ name: '升级前的服务商', baseUrl, enabled: true, apiKey: 'upgrade-test-secret' })
        return window.whomi.settings.saveModel({ providerId: provider.id, label: '升级前的模型', model: 'synthetic-upgrade', contextWindow: 8000, maxTokens: 1000, enabled: true })
      }
      return window.whomi.ai.saveModel({ id: 'upgrade-old-model', label: '升级前的模型', model: 'synthetic-upgrade', baseUrl, contextWindow: 8000, maxTokens: 1000, enabled: true, apiKey: 'upgrade-test-secret' })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    const preparation = await page.evaluate(modelId => window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId }), model.id)
    const task = await page.evaluate(token => window.whomi.ai.confirmAnalysis({ token, requestId: 'upgrade-report' }), preparation.token)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), task.id), { timeout: 30000 }).toMatchObject({ state: 'completed' })
    const thread = await page.evaluate(() => window.whomi.ai.openThread('1'))
    const turn = await page.evaluate(input => window.whomi.ai.sendTurn(input), { threadId: thread.id, requestId: 'upgrade-question', prompt: '升级前的问题', referenceIds: ['1'], modelId: model.id })
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getThread(id), thread.id), { timeout: 30000 }).toMatchObject({ turns: [{ id: turn.id, state: 'completed' }] })
    let pausedTaskId
    if (oldInfo.version === '0.1.5' || oldMemory) {
      pauseLegacy = true
      const second = await page.evaluate(async modelId => {
        const prepared = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId })
        return window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId: 'upgrade-paused' })
      }, model.id)
      await expect.poll(() => legacyRequests).toBe(2)
      await page.evaluate(id => window.whomi.ai.stopAnalysis(id), second.id)
      await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), second.id)).toMatchObject({ state: 'stopped', analyzedMessages: 1 })
      pauseLegacy = false
      pausedTaskId = second.id
    }
    const before = await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.snapshot', null))
    await app.close()
    app = await launch(process.env.WHOMI_PACKAGED_EXECUTABLE)
    page = await app.firstWindow()
    await expect(page.locator('main')).toBeVisible()
    expect(await app.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName() }))).toEqual({ version, name: oldInfo.name })
    expect(await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.snapshot', null))).toEqual(before)
    await page.getByRole('button', { name: '记忆仓库', exact: true }).click()
    await page.locator('.memory-task-row:not(.is-pending)').first().click()
    const oldReport = page.getByRole('dialog', { name: oldMemory ? '我们的记忆' : '分析报告' })
    await expect(oldReport.getByText(oldMemory ? '升级前保存的示例文稿。' : '升级前的合成报告', { exact: true })).toBeVisible()
    await expect(oldReport.getByRole('heading', { name: 'MBTI 预测' })).toHaveCount(oldMemory ? 1 : 0)
    await page.screenshot({ path: join(evidence, 'legacy-report.png') })
    await page.keyboard.press('Escape')
    if (pausedTaskId) {
      const requestsAtUpgrade = authorizations.length
      await page.evaluate(id => window.whomi.ai.continueAnalysis(id), pausedTaskId)
      await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), pausedTaskId), { timeout: 30000 })
        .toMatchObject({ id: pausedTaskId, state: 'completed', report: originalReport })
      expect(authorizations.length - requestsAtUpgrade).toBe(1)
      await expect(page.locator('.memory-task-row:not(.is-pending)')).toHaveCount(2)
    }
    const afterResume = await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.snapshot', null))
    const migrated = await page.evaluate(() => window.whomi.settings.get())
    expect(migrated.providers).toHaveLength(1)
    expect(migrated.models[0]).toMatchObject({ id: model.id, label: '升级前的模型', hasCredential: true })
    expect(JSON.stringify(migrated)).not.toContain('upgrade-test-secret')
    const unsafeDestination = await mkdtemp(join(dirname(resolve(process.env.WHOMI_PACKAGED_EXECUTABLE)), 'upgrade-reject-data-'))
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, unsafeDestination)
    const denied = await page.evaluate(async () => { try { await window.whomi.settings.chooseStorage(); return null } catch (error) { return error } })
    expect(denied).toMatchObject({ code: 'INVALID_STORAGE_PATH', action: '请选择安装目录之外的空文件夹。' })
    await page.evaluate(id => window.whomi.settings.testModel(id), model.id)
    expect(authorizations.every(value => value === 'Bearer upgrade-test-secret')).toBe(true)
    expect(await page.evaluate(id => window.whomi.ai.getReport(id), task.id)).toMatchObject(originalReport)
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('navigation').getByRole('button', { name: '升级验收 · 虚构会话', exact: true }).click()
    await expect(page.locator('.message-text')).toContainText('升级前保存的消息，保留原文。')
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
    await expect(page.getByText('升级验收合成回答', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, 'upgrade-conversation-preserved.png') })
    await page.evaluate(async modelId => { const current = await window.whomi.settings.get(); await window.whomi.settings.saveProcessing({ ...current.processing, mergeSeconds: 17, denoise: true }); await window.whomi.settings.selectModel('conversation', modelId); await window.whomi.settings.selectModel('analysis', modelId) }, model.id)
    const configured = await page.evaluate(() => window.whomi.settings.get())
    await app.close()
    app = await launch(process.env.WHOMI_PACKAGED_EXECUTABLE)
    page = await app.firstWindow()
    await expect(page.locator('main')).toBeVisible()
    expect(await page.evaluate(() => window.whomi.settings.get())).toEqual(configured)
    expect(await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.snapshot', null))).toEqual(afterResume)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByLabel('替换密钥', { exact: true })).toHaveValue('')
    await page.screenshot({ path: join(evidence, 'upgrade-settings-preserved.png') })
    await writeFile(join(evidence, 'upgrade-result.json'), JSON.stringify({ oldVersion: oldInfo.version, version, preservedTables: Object.keys(before), encryptedCredentialUsable: true, configurationRestartPreserved: true, ...(pausedTaskId ? { legacyResumedTask: pausedTaskId, remainingModelRequests: 1 } : {}) }, null, 2))
  } finally {
    await app?.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})
