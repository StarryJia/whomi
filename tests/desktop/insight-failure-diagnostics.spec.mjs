import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { meetingChat } from './fixtures/pi-insight-model.mjs'

test('同一洞察任务两次被拒绝时，从提醒打开对应尝试的脱敏日志', async ({}, info) => {
  test.setTimeout(120_000)
  const privateValues = ['sk-test-issue46', 'sample46@example.invalid', '合成聊天片段四十六', 'https://example.invalid/v1?key=private46']
  const failures = [
    { code: 'INSIGHT_TOOL_REASONING_CONFLICT', reason: 'Function tools with reasoning are not supported on Chat Completions. Use Responses or set reasoning_effort to none.', action: /读取工具.*思考参数/ },
    { code: 'INSIGHT_REASONING_UNSUPPORTED', reason: "Unsupported value: 'none' for reasoning_effort. Supported values are low, medium, high.", action: /思考强度/ },
  ]
  let attempt = 0
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'invalid_request_error', message: [failures[attempt].reason, ...privateValues].join(' ') } }))
  })
  const root = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(root, 'whomi-runtime-issue46-')))
  let app, page
  const launch = () => electron.launch({
    args: [resolve(process.env.WHOMI_DESKTOP_TEST_ENTRY ?? 'out/main/index.cjs'), '--whomi-runtime-test'],
    env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  })
  try {
    await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done))
    const file = join(directory, '合成会话.json')
    const chat = meetingChat(8)
    chat.messages = chat.messages.slice(0, 8)
    await writeFile(file, JSON.stringify(chat))
    await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
    app = await launch()
    page = await app.firstWindow()
    await page.evaluate(async baseUrl => {
      const api = window.whomi.settings
      const provider = await api.saveProvider({ name: '受控模型服务', baseUrl, apiKey: 'synthetic-only', enabled: true })
      const model = await api.saveModel({ providerId: provider.id, model: 'example', label: '测试模型', contextWindow: 16000, maxTokens: 2000, enabled: true })
      await api.selectModel('analysis', model.id)
    }, 'http://127.0.0.1:' + server.address().port + '/v1')
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const button = name => page.getByRole('button', { name, exact: true })
    await app.evaluate(({ dialog, shell }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      globalThis.openedInsightLogs = []
      shell.openPath = async path => { globalThis.openedInsightLogs.push(path); return '' }
    }, file)
    await button('导入会话').click()
    await button('选择文件').click()
    await button('打开会话').click()
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await identity.getByRole('radio', { name: /合成本人/ }).check()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await expect(identity).toHaveCount(0)
    await button('会话洞察').click()
    const attempts = []
    for (const [index, failure] of failures.entries()) {
      attempt = index
      await button(index === 0 ? '开始洞察' : '重试').click()
      const notice = page.getByRole('region', { name: '异常提醒' })
      await notice.getByRole('button', { name: '展开详情' }).click()
      await expect(notice).toContainText(failure.action)
      const task = await page.evaluate(async () => (await window.whomi.ai.listAnalyses())[0])
      expect(task).toMatchObject({ state: 'failed', analyzedMessages: 0, totalMessages: 8, failureAtMs: expect.any(Number), failureOperationId: expect.any(String) })
      await notice.getByRole('button', { name: '打开本次操作日志' }).click()
      const opened = () => app.evaluate(() => globalThis.openedInsightLogs)
      await expect.poll(opened).toHaveLength(index + 1)
      const path = (await opened())[index]
      expect(dirname(path)).toBe(join(directory, 'logs', 'operations'))
      const contents = await readFile(path, 'utf8')
      expect(contents).toContain('操作编号：' + task.failureOperationId)
      expect(contents).toContain('任务编号=' + task.id)
      expect(contents).toContain('结果：失败')
      expect(contents).toContain(failure.code)
      expect(contents).toContain('收到服务响应=是')
      expect(contents).toContain('服务状态码=400')
      const logRoot = join(directory, 'logs')
      const records = async () => Promise.all((await readdir(logRoot)).filter(name => name.includes('-insight-' + task.id + '-') && name.endsWith('.json'))
        .map(async name => JSON.parse(await readFile(join(logRoot, name), 'utf8'))))
      await expect.poll(records).toContainEqual(expect.objectContaining({ taskId: task.id, operationId: task.failureOperationId, code: failure.code }))
      const json = JSON.stringify(await records())
      for (const value of privateValues) {
        expect(contents).not.toContain(value)
        expect(json).not.toContain(value)
        await expect(notice).not.toContainText(value)
      }
      await info.attach('attempt-' + (index + 1) + '.txt', { path, contentType: 'text/plain' })
      if (index === 1) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 640))
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
      }
      await expect(notice.getByRole('button', { name: '打开本次操作日志' })).toBeInViewport()
      await page.screenshot({ path: info.outputPath(index === 0 ? 'first-refusal.png' : 'second-refusal-narrow.png'), animations: 'disabled' })
      attempts.push({ id: task.id, operationId: task.failureOperationId, path })
      await notice.getByRole('button', { name: '关闭提醒' }).click()
    }
    expect(attempts[1].id).toBe(attempts[0].id)
    expect(attempts[1].operationId).not.toBe(attempts[0].operationId)
    expect(attempts[1].path).not.toBe(attempts[0].path)
    await page.evaluate(async () => {
      const settings = window.whomi.settings
      const { models, selectedModels } = await settings.get()
      const model = models.find(item => item.id === selectedModels.analysis)
      await settings.saveModel({ id: model.id, providerId: model.providerId, model: model.model, label: model.label,
        enabled: true, contextWindow: 32000, maxTokens: model.maxTokens })
    })
    await button('重试').click()
    const notice = page.getByRole('region', { name: '异常提醒' })
    await notice.getByRole('button', { name: '展开详情' }).click()
    await expect(notice).toContainText('模型配置已更新')
    await notice.getByRole('button', { name: '打开本次操作日志' }).click()
    await expect.poll(() => app.evaluate(() => globalThis.openedInsightLogs)).toHaveLength(3)
    const path = await app.evaluate(() => globalThis.openedInsightLogs[2])
    const contents = await readFile(path, 'utf8')
    expect(attempts.map(item => item.path)).not.toContain(path)
    expect(contents).toContain('阶段=准备恢复洞察')
    expect(contents).toContain('MODEL_CHANGED')
    expect(contents).toContain('任务编号=' + attempts[1].id)
    await info.attach('resume-preparation.txt', { path, contentType: 'text/plain' })
    const previous = await page.evaluate(id => window.whomi.ai.getAnalysis(id), attempts[1].id)
    expect(previous).toMatchObject({ state: 'failed', failureOperationId: attempts[1].operationId })
    expect(previous.error).toMatch(failures[1].action)
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await app?.close()
    await new Promise(done => server.close(done))
    for (const name of ['logs', 'Crashpad']) await cp(join(directory, name), info.outputPath(name), { recursive: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (dirname(directory) === root && basename(directory).startsWith('whomi-runtime-issue46-')) await rm(directory, { recursive: true, force: true })
  }
})
