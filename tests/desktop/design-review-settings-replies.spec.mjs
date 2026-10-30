import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const evidence = resolve('release/design-review-20261031')
async function launch(directory) {
  await mkdir(evidence, { recursive: true })
  const app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  const page = await app.firstWindow()
  await expect(page.locator('.startup-intro')).toHaveCount(0, { timeout: 15000 })
  return { app, page }
}

test('settings use an inline model catalog and a neutral grouped number focus', async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-design-settings-'))
  await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
  let fail = true
  const server = createServer((_request, response) => {
    response.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(fail ? { error: { message: 'test unavailable' } } : { data: [{ id: 'example/chat-alpha' }, { id: 'example/chat-beta' }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app
  try {
    const launched = await launch(directory); app = launched.app
    const page = launched.page, errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '添加服务商', exact: true }).click()
    await page.getByLabel('服务商名称', { exact: true }).fill('示例服务商')
    await page.getByLabel('接口地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
    await expect(page.getByRole('combobox', { name: '连接协议' })).toHaveCount(0)
    await expect(page.getByText('有未保存的修改', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(evidence, '05-provider-after.png') })
    await page.getByRole('button', { name: '保存服务商', exact: true }).click()
    await page.getByRole('button', { name: '同步模型', exact: true }).click()
    const catalog = page.getByRole('region', { name: '同步模型列表' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await catalog.getByRole('button', { name: '重试同步' }).waitFor()
    fail = false
    await catalog.getByRole('button', { name: '重试同步' }).click()
    await catalog.getByRole('checkbox', { name: 'example/chat-alpha', exact: true }).check()
    await catalog.getByRole('button', { name: '添加所选模型 (1)' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, '06-models-inline-after.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
    await catalog.getByRole('button', { name: '添加所选模型 (1)' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, '07-models-narrow-after.png') })
    expect(await page.locator('.ms-detail').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 320); window.setSize(360, 800) })
    await catalog.getByRole('button', { name: '添加所选模型 (1)' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, '10-models-360-after.png') })
    expect(await page.locator('.ms-detail').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
    await catalog.getByRole('button', { name: '收起模型列表' }).click()
    await expect(catalog).toHaveCount(0)
    await page.getByRole('button', { name: '同步模型', exact: true }).click()
    await catalog.getByRole('checkbox', { name: 'example/chat-alpha', exact: true }).check()
    await catalog.getByText('高级设置', { exact: true }).click()
    await catalog.getByLabel('上下文长度', { exact: true }).fill('8192')
    await catalog.getByLabel('最大输出长度', { exact: true }).fill('1024')
    await catalog.getByRole('button', { name: '添加所选模型 (1)' }).click()
    await expect(page.locator('.ms-model-row')).toHaveCount(1)
    await expect(catalog).toHaveCount(0)
    await page.getByRole('button', { name: '消息处理', exact: true }).click()
    const number = page.getByRole('spinbutton', { name: '合并时间窗口', exact: true })
    await number.click()
    expect(await number.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('none')
    expect(await number.evaluate(e => e.validity.valid)).toBe(true)
    await expect(page.getByText('修改后自动保存', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(evidence, '03-processing-after.png') })
    await number.fill('601'); await number.press('Tab')
    await expect(page.getByRole('alert')).toHaveText('请输入 1～600 的整数秒数。')
    await number.fill('61'); await number.press('Tab')
    await expect.poll(() => page.evaluate(async () => (await window.whomi.settings.get()).processing.mergeSeconds)).toBe(61)
    expect(errors).toEqual([])
  } finally { await app?.close(); await new Promise(resolve => server.close(resolve)) }
})

test('SIWX reimport repairs an old quote and jumps across unloaded pages without losing the draft', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-siwx-design-'))
  await writeFile(join(directory, 'probe.cjs'), `module.exports=(writer,reader)=>method=>{
    if(method==='probe.oldQuote'){writer.exec("UPDATE message_replies SET target_message_id=NULL,original_id=NULL,id_namespace=NULL,sender_name=NULL,sent_at_ms=NULL,state='unresolved'");return true}
    if(method==='probe.counts')return {messages:Number(reader.prepare('SELECT count(*) n FROM messages').get().n),resolved:Number(reader.prepare("SELECT count(*) n FROM message_replies WHERE state='resolved'").get().n)};
    throw Error('Unsupported')
  }`)
  const source = join(directory, 'siwx.json'), firstId = '9007199254740993123'
  await writeFile(source, JSON.stringify({ exportInfo: { exporter: 'SIWX', wxid: 'example-owner' }, session: { wxid: 'example-peer', displayName: 'SIWX 引用 · 虚构验收', type: '私聊', messageCount: 700 }, messages: Array.from({ length: 700 }, (_, index) => ({
    platformMessageId: String(BigInt(firstId) + BigInt(index)), localId: index + 1, createTime: 1700000000 + index,
    senderUsername: index % 2 ? 'example-b' : 'example-a', senderDisplayName: index % 2 ? '示例乙' : '示例甲', isSend: index % 2,
    typeName: index === 699 ? '引用消息' : '文本消息', localType: index === 699 ? 49 : 1,
    content: index === 0 ? '原消息：周六一起练习。' : index === 699 ? '好的' : `示例消息 ${index + 1}`,
    ...(index === 699 ? { quote: { content: '原消息：周六一起练习。', displayname: '示例甲', ts: 1700000000 }, rawContent: `<msg><appmsg><refermsg><svrid>${firstId}</svrid></refermsg></appmsg></msg>` } : {}),
  })) }))
  const { app, page } = await launch(directory)
  try {
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, source)
    async function importSource(existing = false) {
      await page.getByRole('button', { name: '导入会话', exact: true }).click()
      await page.getByRole('button', { name: '选择文件', exact: true }).click()
      const discovery = page.getByRole('region', { name: '发现的文件入口' })
      await discovery.getByRole('checkbox').check()
      await page.getByRole('button', { name: '解析所选入口' }).click()
      const target = page.getByLabel('导入目标', { exact: true })
      await target.waitFor()
      if (!existing) await target.selectOption('new')
      else {
        const options = await target.locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })))
        await target.selectOption(options.find(item => item.text.includes('SIWX 引用')).value)
      }
      await page.getByRole('button', { name: '确认保存', exact: true }).click()
      await expect(page.getByText('导入完成。', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '打开会话', exact: true }).click()
    }
    await importSource()
    await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.oldQuote', null))
    await page.reload()
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('button', { name: 'SIWX 引用 · 虚构验收', exact: true }).click()
    for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '加载后文', exact: true }).click()
    await expect(page.locator('blockquote.message-quote')).toHaveCount(1)
    await page.locator('.message-quote').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, '08-quote-before.png') })
    await importSource(true)
    for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '加载后文', exact: true }).click()
    const draft = page.getByRole('textbox', { name: '向 AI 提问', exact: true })
    await draft.fill('保留这段虚构草稿')
    const reply = page.getByRole('button', { name: /查看引用原消息/ })
    await reply.scrollIntoViewIfNeeded(); await reply.click()
    await expect(page.locator('.message-reference-target .message-text')).toHaveText('原消息：周六一起练习。')
    const targetMessageId = await page.locator('.message-reference-target').getAttribute('data-message-id')
    const targetMessage = page.locator(`[data-message-id="${targetMessageId}"]`)
    await expect.poll(() => targetMessage.evaluate(e => {
      const target = e.getBoundingClientRect(), reader = e.closest('.reader-scroll').getBoundingClientRect()
      return target.top >= reader.top && target.bottom <= reader.bottom
    })).toBe(true)
    await expect(draft).toHaveValue('保留这段虚构草稿')
    await page.screenshot({ path: join(evidence, '09-quote-target-after.png') })
    await page.getByRole('button', { name: '返回引用位置', exact: true }).click()
    await expect(page.locator('.message-reference-target .message-text')).toHaveText('好的')
    expect(await app.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.counts', null))).toEqual({ messages: 700, resolved: 1 })
  } finally { await app.close() }
})
