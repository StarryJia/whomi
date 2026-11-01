import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const width of [1440, 360]) {
  test(`首条 AI 对话与缺模型时的设置往返 · ${width}`, async () => {
    test.setTimeout(90000)
    const data = await mkdtemp(join(tmpdir(), 'whomi-runtime-entry-'))
    const evidence = resolve('artifacts/conversation-entry-018')
    await mkdir(evidence, { recursive: true })
    await writeFile(join(data, 'probe.cjs'), `module.exports = writer => {
      writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'虚构 · 周末出行','direct',0); INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'fixture','trip'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','小禾'); INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user'); INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','小禾','text','周六十点在车站见。',0);")
      return async () => true
    }`)
    const app = await electron.launch({
      ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
      env: { ...process.env, WHOMI_RUNTIME_TEST: data },
    })
    try {
      const page = await app.firstWindow()
      const button = name => page.getByRole('button', { name, exact: true })
      const screenshot = state => page.screenshot({ path: join(evidence, width + '-' + state + '.png'), animations: 'disabled' })
      await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320,320); win.setSize(size,820) }, width)
      if (width === 360) {
        const nav = page.getByRole('button', { name: '展开侧栏', exact:true })
        if (await nav.isVisible()) await nav.click()
      }
      await page.evaluate(() => window.whomi.settings.saveProvider({ name:'演示连接', baseUrl:'http://127.0.0.1:9090/v1', enabled:true }))
      await button('展开会话列表').click()
      await button('虚构 · 周末出行').click()
      await button('AI 对话').click()
      await button('显示对话列表').click()
      await expect(button('开始新对话')).toBeVisible()
      const history = page.getByRole('navigation', { name:'AI 对话列表' })
      expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await screenshot('首次对话')
      await button('开始新对话').click()
      const draft = page.getByRole('textbox', {name:'向 AI 提问'})
      await expect(draft).toBeFocused()
      await draft.fill('保留这条虚构草稿')
      await button('配置模型').click()
      await expect(page.getByLabel('搜索服务商', {exact:true})).toBeVisible()
      await button('返回').click()
      await expect(draft).toHaveValue('保留这条虚构草稿')
      await expect(draft).toBeFocused()
      expect(await page.evaluate(async () => (await window.whomi.ai.listThreads('1')).length)).toBe(1)
      await page.keyboard.press('Escape')
      await button('整理成记忆').click()
      await screenshot('确认去设置')
      await button('配置模型').click()
      await expect(page.getByLabel('搜索服务商', {exact:true})).toBeVisible()
      const savedProvider = button('演示连接')
      if (await savedProvider.isVisible()) await savedProvider.click()
      await button('手动添加').click()
      await page.getByLabel('模型标识', {exact:true}).fill('fictional-offline-model')
      await page.getByRole('dialog', { name:'手动添加模型' }).getByRole('button', { name:'添加模型',exact:true }).click()
      await expect(page.locator('.ms-model-row')).toHaveCount(1)
      await button('返回').click()
      await expect(page.getByRole('heading', {name:'整理成记忆'})).toBeVisible()
      const model = page.getByRole('combobox', {name:'分析模型'})
      await model.click()
      await page.getByRole('option', {name:/fictional-offline-model/}).click()
      await expect(button('生成记忆')).toBeEnabled()
      expect(await page.evaluate(async () => (await window.whomi.ai.listAnalyses()).length)).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally { await app.close() }
  })
}
