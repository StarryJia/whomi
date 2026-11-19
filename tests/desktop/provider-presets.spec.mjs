import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const providerName = '深度求索'
const customName = '自定义本机服务'
const localEndpoint = 'http://127.0.0.1:9090/v1'

test('browse offline provider presets, configure one, and retain custom accounts across restarts', async ({}, info) => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-provider-presets-'))
  const evidence = info.outputPath('screenshots')
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), `module.exports = (_writer, reader) => async method => {
      if (method !== 'probe.accountCounts') throw Error('Unsupported test probe')
      return {
        providers: Number(reader.prepare('SELECT COUNT(*) AS n FROM settings_providers').get().n),
        models: Number(reader.prepare('SELECT COUNT(*) AS n FROM settings_models').get().n)
      }
    }`)

    async function launchSettings() {
      app = await electron.launch({
        ...(process.env.WHOMI_PACKAGED_EXECUTABLE
          ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
          : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
        env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
      })
      const page = await app.firstWindow()
      await page.context().setOffline(true)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByLabel('搜索服务商', { exact: true })).toBeVisible()
      return page
    }

    const counts = () => app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.accountCounts', null))
    async function resize(page, width) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(320, 320)
        window.setSize(size, 800)
      }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    }

    let page = await launchSettings()
    await resize(page, 1280)
    const directoryRows = page.locator('.ms-provider-results .ms-provider-copy strong')
    await expect(directoryRows).toHaveText([
      '智谱开放平台', '深度求索', 'Ollama', 'LM Studio', 'Anthropic', 'OpenAI Codex', 'OpenAI', 'Gemini',
      '月之暗面', '月之暗面海外版', '百川', '千问 AI 平台（原阿里云百炼）', 'QwenCloud', '阶跃星辰',
      '豆包（火山引擎 Ark）', 'MiniMax', '英伟达', 'Grok', 'Mistral', 'Perplexity',
      'TokenHub', '百度云千帆', '龙猫', 'Xiaomi MiMo', 'Z.ai', 'MiniMax 海外版',
    ])
    await page.screenshot({ path: join(evidence, '01-fresh-offline-directory.png') })
    const search = page.getByLabel('搜索服务商', { exact: true })
    await search.fill('OpenRouter')
    await expect(page.getByText('未找到服务商')).toBeVisible()
    await search.fill('deepseek')
    const presetRow = page.getByRole('button', { name: providerName, exact: true })
    await expect.poll(() => presetRow.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
    await presetRow.click()
    const configure = page.getByRole('button', { name: '配置服务商', exact: true })
    await configure.click()
    let editor = page.getByRole('dialog')
    await expect(editor.getByLabel('接口地址', { exact: true })).toHaveValue(/^https:\/\/api\.deepseek\.com(?:\/|$)/)
    await expect(editor.getByLabel('密钥', { exact: true })).toHaveValue('')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    expect(await counts()).toEqual({ providers: 0, models: 0 })

    await page.evaluate(name => window.whomi.settings.saveProvider({
      name, enabled: true, baseUrl: 'http://127.0.0.1:8080/v1',
    }), customName)
    await app.close()
    page = await launchSettings()
    await expect(page.locator('.ms-provider-results .ms-provider').first()).toHaveAccessibleName(customName)
    await page.getByLabel('搜索服务商', { exact: true }).fill(providerName)
    await page.getByRole('button', { name: providerName, exact: true }).click()
    await resize(page, 360)
    await expect(page.getByRole('button', { name: '配置服务商', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, '02-narrow-preset-details.png') })
    await page.getByRole('button', { name: '配置服务商', exact: true }).click()
    editor = page.getByRole('dialog')
    await editor.getByLabel('接口地址', { exact: true }).fill(localEndpoint)
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(counts).toEqual({ providers: 2, models: 0 })

    await resize(page, 1280)
    await app.close()
    page = await launchSettings()
    await expect(page.getByRole('button', { name: customName, exact: true })).toHaveCount(1)
    await page.getByLabel('搜索服务商', { exact: true }).fill('deepseek')
    const savedRow = page.getByRole('button', { name: providerName, exact: true })
    await expect(savedRow).toHaveCount(1)
    await savedRow.click()
    await expect(page.getByLabel('接口地址', { exact: true })).toHaveValue(localEndpoint)
    expect(await counts()).toEqual({ providers: 2, models: 0 })
    await page.screenshot({ path: join(evidence, '03-restarted-provider-details.png') })
  } finally {
    await app?.close()
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})

test('upgrade keeps an unlisted preset, a manual gateway and the old default model usable', async ({}, info) => {
  test.setTimeout(80_000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-provider-upgrade-'))
  const received = []
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      received.push({ path: request.url, authorized: request.headers.authorization === 'Bearer fixture-old-key' })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'provider-upgrade', choices: [{ index: 0, delta: { content: '合成旧预置回答' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'provider-upgrade', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  let app, page
  const button = name => page.getByRole('button', { name, exact: true })
  async function launch() {
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
  }
  try {
    await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => async () => {
      writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'合成服务商会话','direct',0);
        INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','providers');
        INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'self','示例本人');
        INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
        INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','示例本人','text','合成消息',0);\`)
      return true
    }`)
    await launch()
    await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seedConversation', null))
    const oldModelId = await page.evaluate(async url => {
      const provider = await window.whomi.settings.saveProvider({ presetId: 'openrouter', name: 'OpenRouter',
        protocol: 'openai-completions', baseUrl: url + '/old/v1', enabled: true, apiKey: 'fixture-old-key', avatarId: 'openrouter' })
      const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '升级前默认模型', model: 'old-example',
        contextWindow: 8000, maxTokens: 1000, enabled: true })
      await window.whomi.settings.selectModel('conversation', model.id)
      return model.id
    }, address)
    await button('设置').click()
    await button('添加服务商').click()
    const editor = page.getByRole('dialog', { name: '添加自定义服务商' })
    await editor.getByLabel('服务商名称').fill('合成中转')
    await editor.getByLabel('OpenAI', { exact: true }).fill(address + '/manual/v1')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await button('手动添加').click()
    const modelEditor = page.getByRole('dialog', { name: '手动添加模型' })
    await modelEditor.getByLabel('模型标识').fill('example/manual')
    await modelEditor.getByRole('button', { name: '添加模型', exact: true }).click()
    await expect(modelEditor).toHaveCount(0)
    await app.close(); app = undefined
    await launch()
    await button('设置').click()
    for (const [name, path] of [['OpenRouter', '/old/v1'], ['合成中转', '/manual/v1']]) {
      await button(name).click()
      await expect(page.getByLabel('接口地址', { exact: true })).toHaveValue(address + path)
    }
    await page.screenshot({ path: info.outputPath('configured-gateway-after-restart.png') })
    const thread = await page.evaluate(async () => {
      const selected = (await window.whomi.settings.get()).selectedModels.conversation
      const thread = await window.whomi.ai.createThread('1')
      await window.whomi.ai.sendTurn({ threadId: thread.id, requestId: 'upgrade-legacy-default',
        modelId: selected, prompt: '合成问题', referenceIds: [] })
      return thread.id
    })
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getThread(id), thread)).toMatchObject({
      turns: [{ modelId: oldModelId, state: 'completed', text: '合成旧预置回答' }],
    })
    expect(received).toEqual([{ path: '/old/v1/chat/completions', authorized: true }])
    await button('返回').click()
    if (await button('展开会话列表').isVisible()) await button('展开会话列表').click()
    await button('合成服务商会话').click()
    await button('AI 对话').click()
    const models = page.getByRole('combobox', { name: '对话模型' })
    await expect(models).toContainText('升级前默认模型')
    await models.click()
    await expect(page.getByRole('option', { name: /example\/manual/ })).toBeVisible()
    await page.screenshot({ path: info.outputPath('manual-gateway-in-model-picker.png') })
  } catch (error) {
    await page?.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
