import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('系统提示词保存、取消、失败重试、重启及实际请求', async () => {
  test.setTimeout(120000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-prompts-'))
  const evidence = resolve('docs/designs/assets/system-prompts')
  await mkdir(evidence, { recursive: true })
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: { content: '测试回答' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(directory, 'probe.cjs'), `module.exports=(writer)=>async method=>{
    if(method==='probe.fail'){writer.exec("CREATE TRIGGER fail_prompt BEFORE UPDATE ON app_settings WHEN NEW.key='systemPrompts' BEGIN SELECT RAISE(ABORT,'test write failure'); END");return true;}
    if(method==='probe.restore'){writer.exec('DROP TRIGGER fail_prompt');return true;}
    if(method!=='probe.seed')throw Error('Unsupported');
    writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'提示词验收示例','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','prompts');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
      INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','周末一起散步',0);\`);return true;}`)
  let app
  const launch = () => electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  const openSettings = async page => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const category = page.getByRole('button', { name: '分类', exact: true })
    if (await category.isVisible()) await category.click()
    await page.getByRole('button', { name: '系统提示词', exact: true }).click()
    await expect(page.getByRole('button', { name: '编辑记忆成稿' })).toBeVisible()
  }
  try {
    app = await launch()
    let page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.seed', null))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await openSettings(page)
    await page.screenshot({ path: join(evidence, 'desktop-list.png') })
    await page.getByRole('button', { name: '记忆成稿说明' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: '记忆成稿说明' })).toContainText('对应功能')
    await page.screenshot({ path: join(evidence, 'desktop-help.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '记忆成稿说明' })).toBeFocused()
    await page.getByRole('button', { name: '编辑记忆成稿' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: '提示词内容' })).toBeFocused()
    const original = await page.getByRole('textbox', { name: '提示词内容' }).inputValue()
    await page.screenshot({ path: join(evidence, 'desktop-editor.png') })
    await page.keyboard.insertText('未保存的示例草稿')
    await expect(page.getByRole('textbox')).not.toHaveValue(original)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '放弃修改' }).click()
    await expect(page.getByRole('button', { name: '编辑记忆成稿' })).toBeFocused()
    await page.getByRole('button', { name: '编辑记忆成稿' }).click()
    await expect(page.getByRole('textbox')).toHaveValue(original)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '编辑AI 对话' }).click()
    await page.getByRole('textbox').fill('回答请使用简短句子。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.fail', null))
    await page.getByRole('button', { name: '编辑AI 对话' }).click()
    await page.getByRole('textbox').fill('先回应用户提到的具体经历。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveValue('先回应用户提到的具体经历。')
    await page.screenshot({ path: join(evidence, 'save-failure.png') })
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.restore', null))
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await openSettings(page)
    await page.getByRole('button', { name: '编辑AI 对话' }).click()
    await expect(page.getByRole('textbox')).toHaveValue('先回应用户提到的具体经历。')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    const port = server.address().port
    const turn = await page.evaluate(async port => {
      const provider = await window.whomi.settings.saveProvider({ name: '合成测试', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true, apiKey: 'test-only' })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成模型', model: 'test', contextWindow: 8000, maxTokens: 1000, enabled: true })
      const thread = await window.whomi.ai.createThread('1')
      return window.whomi.ai.sendTurn({ threadId: thread.id, requestId: 'prompt-e2e', modelId: model.id, prompt: '你好', referenceIds: [] })
    }, port)
    await expect.poll(async () => (await page.evaluate(id => window.whomi.ai.getThread(id), turn.threadId)).turns[0].state).toBe('completed')
    expect(JSON.stringify(requests)).toContain('先回应用户提到的具体经历。')
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 320); window.setSize(360, 800) })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '记忆取材说明' }).click()
    const popup = page.getByRole('dialog', { name: '记忆取材说明' })
    await expect(popup).toBeVisible()
    const box = await popup.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(361)
    await page.screenshot({ path: join(evidence, 'narrow-help.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '编辑记忆成稿' }).click()
    await expect(page.getByRole('textbox')).toBeVisible()
    await page.screenshot({ path: join(evidence, 'narrow-editor.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const close = page.getByRole('button', { name: '关闭编辑提示词 · 记忆成稿' })
    expect((await close.boundingBox()).y).toBeGreaterThanOrEqual(36)
    await close.click()
    await expect(page.getByRole('textbox')).toHaveCount(0)
  } finally { await app?.close(); await new Promise(resolve => server.close(resolve)) }
})
