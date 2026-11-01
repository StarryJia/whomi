import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

test('自定义服务商在宽窄窗口配置头像和两个端点，重启后按默认协议读取模型', async () => {
  test.setTimeout(120000)
  const data = await mkdtemp(join(tmpdir(), 'whomi-runtime-custom-provider-'))
  const evidence = resolve('release/provider-account-validation/custom-provider')
  const paths = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    paths.push(path)
    if (path === '/a/v1/models' && request.headers['x-api-key'] === 'fixture-only') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'example-text', display_name: '测试模型' }], has_more: false }))
    } else if (path === '/a/v1/messages' && request.headers['x-api-key'] === 'fixture-only') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of [
        { type: 'message_start', message: { id: 'example', type: 'message', role: 'assistant', model: 'example-text', content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
      response.end()
    } else response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const host = 'http://127.0.0.1:' + server.address().port
  let app, page
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 320); win.setSize(width, 800) }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  }
  async function launch() {
    app = await electron.launch({
      ...(process.env.WHOMI_PACKAGED_EXECUTABLE
        ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
        : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
      env: { ...process.env, WHOMI_RUNTIME_TEST: data },
    })
    page = await app.firstWindow()
    await resize(1280)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByLabel('搜索服务商', { exact: true })).toBeVisible()
  }
  const shot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(data, 'probe.cjs'), 'module.exports=()=>async()=>true')
    await launch()
    const add = page.getByRole('button', { name: '添加服务商', exact: true })
    await add.click()
    let dialog = page.getByRole('dialog', { name: '添加自定义服务商' })
    await expect(dialog.getByRole('heading', { name: '添加自定义服务商' })).toBeFocused()
    await expect(dialog.getByRole('button', { name: '重置头像' })).toBeDisabled()
    await shot('01-wide-empty')
    await dialog.getByLabel('服务商名称', { exact: true }).fill('取消示例')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(add).toBeFocused()
    expect((await page.evaluate(() => window.whomi.settings.get())).providers).toHaveLength(0)
    await add.click()
    await dialog.getByRole('button', { name: '内置头像' }).click()
    await dialog.getByRole('button', { name: '使用 OpenAI 头像' }).click()
    await dialog.getByLabel('服务商名称', { exact: true }).fill('测试网关')
    await dialog.getByLabel('API 密钥', { exact: true }).fill('fixture-only')
    await dialog.getByLabel('OpenAI', { exact: true }).fill(host + '/o/v1')
    await dialog.getByLabel('Anthropic', { exact: true }).fill('invalid')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect((await page.evaluate(() => window.whomi.settings.get())).providers).toHaveLength(0)
    await resize(360)
    await shot('02-narrow-validation')
    await dialog.getByLabel('Anthropic', { exact: true }).fill(host + '/a')
    await dialog.getByRole('button', { name: '将 Anthropic 设为默认' }).click()
    await expect(dialog.getByText(host + '/a/v1/messages', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '更多设置' }).click()
    await expect(dialog.getByLabel('Google Gemini')).toBeVisible()
    await dialog.getByLabel('Google Gemini').scrollIntoViewIfNeeded()
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await shot('03-narrow-endpoints')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport({ ratio: 1 })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: '同步模型', exact: true }).click()
    await page.getByRole('checkbox', { name: '选择测试模型' }).check()
    await page.getByRole('button', { name: '添加 1 项' }).click()
    await expect(page.locator('.ms-model-row')).toHaveCount(1)
    await page.getByRole('button', { name: '检测测试模型' }).click()
    await expect(page.getByText('连接成功', { exact: true })).toBeVisible({ timeout: 15000 })
    expect(paths).toEqual(['/a/v1/models', '/a/v1/messages'])
    await app.close()
    await launch()
    const state = await page.evaluate(() => window.whomi.settings.get())
    expect(state.providers[0]).toMatchObject({ name: '测试网关', avatarId: 'openai', hasCredential: true, protocol: 'anthropic-messages',
      endpointUrls: { 'openai-completions': host + '/o/v1', 'anthropic-messages': host + '/a' } })
    expect(state.models[0]).toMatchObject({ protocol: 'anthropic-messages', baseUrl: host + '/a' })
    await page.getByRole('button', { name: '测试网关更多操作' }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑服务商' })
    await expect(dialog.getByLabel('替换密钥', { exact: true })).toHaveValue('')
    await expect(dialog.getByLabel('OpenAI', { exact: true })).toHaveValue(host + '/o/v1')
    await expect(dialog.getByLabel('Anthropic', { exact: true })).toHaveValue(host + '/a')
    await expect(dialog.getByAltText('已选服务商图片')).toBeVisible()
    await shot('04-wide-restored')
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(data)) === resolve(tmpdir())) await rm(data, { recursive: true, force: true })
  }
})
