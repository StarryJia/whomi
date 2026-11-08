import { dismissIdentity } from './fixtures/identity.mjs'
import { chatEditor } from './chat-helpers.mjs'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { sourceMessages } from './fixtures/moving-chat.mjs'

for (const width of [1280, 440]) test(`两类会话管理在 ${width} 像素下可拖序、恢复和删除`, async () => {
  test.setTimeout(120000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-lists-'))
  const evidence = resolve('release/handoff-validation/lists')
  const title = '和小林搬家 · 虚构会话'
  const originals = [title, '周末读书', '下周聚餐']
  const threads = ['搬家日程', '备用提问', '搬家清单']
  let app, page
  const launch = async () => {
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, value) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 320); window.setSize(value, 800) }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await page.getByRole('button', { name: '个人总览', exact: true }).waitFor()
  }
  const btn = name => page.getByRole('button', { name, exact: true })
  const menu = name => page.getByRole('menuitem', { name, exact: true })
  const shot = name => page.screenshot({ path: join(evidence, width + '-' + name + '.png'), animations: 'disabled' })
  const history = () => page.getByRole('navigation', { name: 'AI 对话列表' })
  const names = list => list.locator('button[draggable=true]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
  const probe = method => app.evaluate((_electron, method) => globalThis.__whomiRuntimeProbe.request(method, null), method)
  const openList = async () => {
    if (await btn('展开侧栏').isVisible()) await btn('展开侧栏').click()
    if (await btn('展开会话列表').isVisible()) await btn('展开会话列表').click()
    await page.locator('#app-sidebar').evaluate(async el => {
      await new Promise(resolve => requestAnimationFrame(resolve))
      await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
    })
  }
  const choose = async (name, action) => { await btn(name).click({ button: 'right' }); await menu(action).click() }
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => method => {
      if (method === 'probe.unblock') { writer.exec('DROP TRIGGER list_failure'); return true }
      if (method !== 'probe.seed') throw Error('Unknown probe')
      const add = writer.prepare("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(?,?,'direct',0)")
      ;${JSON.stringify(originals)}.forEach((title,i) => add.run(i+1,title))
      const msg = writer.prepare("INSERT INTO messages(conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,'unknown',?,'text',?,?)")
      ;${JSON.stringify(sourceMessages)}.forEach((text,i) => msg.run(i%2?'小林':'我',text,i))
      const thread = writer.prepare("INSERT INTO ai_threads(id,conversation_id,title,created_at_ms,updated_at_ms) VALUES(?,1,?,?,?)")
      ;${JSON.stringify(threads)}.forEach((title,i) => thread.run(i+1,title,3-i,3-i))
      writer.exec("CREATE TRIGGER list_failure BEFORE UPDATE OF pinned ON conversations WHEN old.id=2 BEGIN SELECT RAISE(ABORT,'fixture'); END")
      return true
    }`)
    await launch(); await probe('probe.seed'); await app.close(); await launch()
    await openList()
    const list = () => page.locator('#conversation-list')
    await expect.poll(() => names(list())).toEqual([...originals].reverse())
    await btn(originals[0]).dragTo(btn(originals[2]))
    await expect.poll(() => names(list())).toEqual([originals[0], originals[2], originals[1]])
    await choose(originals[1], '置顶')
    await expect(list().getByRole('alert')).toBeVisible()
    await expect(btn(originals[1])).toHaveAttribute('data-pinned', 'false')
    await shot('pin-retry')
    await probe('probe.unblock'); await list().getByRole('button', { name: '重试' }).click()
    await expect.poll(() => names(list())).toEqual([originals[1], originals[0], originals[2]])
    await btn(originals[1]).click({ button: 'right' }); await expect(menu('取消置顶')).toBeVisible()
    await shot('original-menu'); await menu('取消置顶').click(); await choose(originals[1], '置顶')
    await btn(originals[0]).click()
    await dismissIdentity(page)
    await btn('AI 对话').click()
    const draft = () => chatEditor(page)
    await draft().fill('我还想确认周六的搬家安排')
    await btn('显示对话列表').click()
    await expect.poll(() => names(history())).toEqual(threads)
    await btn(threads[2]).dragTo(btn(threads[0]))
    await expect.poll(() => names(history())).toEqual([threads[2], threads[0], threads[1]])
    await choose(threads[1], '置顶')
    await expect(btn(threads[0])).toHaveAttribute('aria-current', 'true')
    await btn(threads[1]).click({ button: 'right' }); await expect(menu('取消置顶')).toBeVisible()
    await shot('history-menu'); await menu('取消置顶').click(); await choose(threads[1], '置顶')
    await choose(threads[1], '删除'); await expect(page.getByRole('dialog', { name: '删除 AI 对话' })).toContainText('备用提问')
    await btn('取消').click(); await btn('收起对话列表').click()
    await expect(draft()).toHaveText('我还想确认周六的搬家安排')

    await app.close(); await launch(); await openList()
    await expect.poll(() => names(list())).toEqual([originals[1], originals[0], originals[2]])
    await expect(btn(originals[1])).toHaveAttribute('data-pinned', 'true')
    await btn(originals[0]).click(); await dismissIdentity(page); await btn('AI 对话').click(); await btn('显示对话列表').click()
    await expect.poll(() => names(history())).toEqual([threads[1], threads[2], threads[0]])
    await expect(btn(threads[1])).toHaveAttribute('data-pinned', 'true')
    await btn(threads[0]).click(); await draft().fill('保留这条草稿')
    await btn('显示对话列表').click(); await choose(threads[1], '删除'); await btn('确认删除').click()
    await expect.poll(() => names(history())).toEqual([threads[2], threads[0]])
    await btn('收起对话列表').click(); await expect(draft()).toHaveText('保留这条草稿')
    await btn('关闭 AI 对话').click()
    const scroll = page.locator('.reader-scroll')
    const top = await scroll.evaluate(el => { el.scrollTop = 380; return el.scrollTop })
    await openList(); await choose(originals[1], '删除'); await expect(page.getByRole('dialog', { name: '删除会话' })).toContainText('记忆成稿')
    await shot('original-delete'); await btn('取消').click()
    await expect(btn(originals[1])).toBeVisible()
    await choose(originals[1], '删除'); await btn('确认删除').click()
    await expect.poll(() => names(list())).toEqual([originals[0], originals[2]])
    if (width < 600) await btn('收起侧栏').click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(top)
    await btn('AI 对话').click(); await expect(draft()).toHaveText('保留这条草稿')
  } finally {
    await app?.close()
    if (dirname(directory) === resolve(tmpdir()) && directory.includes('whomi-runtime-lists-')) await rm(directory, { recursive: true, force: true })
  }
})
