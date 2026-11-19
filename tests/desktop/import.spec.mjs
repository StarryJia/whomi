import { dismissIdentity } from './fixtures/identity.mjs'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, copyFile, writeFile, appendFile, mkdir, readdir, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'

const malicious = '<img src=x onerror="window.importExecuted=true"><script>window.importExecuted=true</script>'
const fixture = JSON.parse(await readFile('tests/fixtures/import/chatlab/positive.json', 'utf8'))
function documentFor(ids, title = 'Acceptance synthetic') {
  return { ...fixture, meta: { ...fixture.meta, name: title, groupId: title }, messages: ids.map(id => ({ ...fixture.messages[0], platformMessageId: String(id), timestamp: 1700000000 + Number(id), content: id === 1 ? malicious : `synthetic-${id}` })) }
}
async function fingerprint(root) {
  const digest = createHash('sha256')
  async function visit(folder) { for (const name of (await readdir(folder, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) { digest.update(name.name); const path = join(folder, name.name); if (name.isDirectory()) await visit(path); else digest.update(await readFile(path)) } }
  await visit(root); return digest.digest('hex')
}
async function drop(page, path) {
  const box = await page.locator('.import-dropzone').boundingBox()
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: [path], dragOperationsMask: 1 }, point = { x: box.x + box.width / 2, y: box.y + box.height / 2, data }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point })
  await cdp.detach()
}
async function save(page, path) {
  await page.getByRole('button', { name: '导入会话', exact: true }).click()
  await drop(page, path)
  await expect(page.getByText('导入完成', { exact: true })).toBeVisible()
  await expect(page.getByLabel('导入目标', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '预览消息', exact: true })).toHaveCount(0)
}
async function cleanup(directory) {
  const actual = await realpath(directory)
  if (dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('whomi-runtime-')) throw new Error('Unexpected test directory')
  await rm(actual, { recursive: true, force: true })
}
test('import guide stays in the app, adapts to the panel and returns to the same picker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let app
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const executablePath = process.env.WHOMI_PACKAGED_EXECUTABLE
    app = await electron.launch({
      executablePath: executablePath ? resolve(executablePath) : undefined,
      args: executablePath ? ['--whomi-runtime-test'] : [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    const guide = page.getByRole('button', { name: '操作指引', exact: true })
    const picker = page.getByRole('button', { name: '选择文件', exact: true })
    const back = page.getByRole('button', { name: '返回导入', exact: true })
    await app.evaluate(({ shell }) => { globalThis.__guideExternal = []; shell.openExternal = async url => { globalThis.__guideExternal.push(url) } })
    await guide.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: '操作指引' })).toBeFocused()
    await expect(picker).toHaveCount(0)
    await expect(guide).toHaveCount(0)
    const platforms = page.getByRole('navigation', { name: '聊天平台' })
    for (const name of ['微信', 'QQ', 'Telegram', 'WhatsApp', 'Discord', 'Google Chat', 'Instagram', 'LINE']) {
      await platforms.getByRole('button', { name, exact: true }).click()
      await expect(page.getByRole('region', { name, exact: true }).getByRole('listitem')).toHaveCount(3)
    }
    await page.setViewportSize({ width: 360, height: 760 })
    const select = page.getByRole('combobox', { name: '聊天平台' })
    await expect(select).toHaveValue('line')
    await select.selectOption('googlechat')
    await expect(page.getByRole('region', { name: 'Google Chat' })).toContainText('选择文件夹')
    await back.click()
    await expect(guide).toBeFocused()
    await expect(picker).toBeVisible()
    expect(await app.evaluate(() => globalThis.__guideExternal)).toEqual([])
    await drop(page, resolve('docs/readme/weekend.telegram.json'))
    await expect(page.getByText('已保存 8 条消息。', { exact: true })).toBeVisible()
    await expect(guide).toHaveCount(0)
  } finally { await app?.close(); await cleanup(directory) }
})

test('actual import UI preserves old messages, self identity, source bytes and stable locations after restart', async ({}, testInfo) => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  const sources = join(directory, 'sources'), folder = join(sources, 'new-computer')
  const launch = () => electron.launch({ ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }), env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  let application
  try {
    await mkdir(folder, { recursive: true }); await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const first = join(sources, 'first.json'), second = join(folder, 'second.json')
    const conversationTitle = '示例联系人'
    await writeFile(first, JSON.stringify(documentFor([1,2,3], conversationTitle)))
    const changed = documentFor([2,4], conversationTitle)
    changed.meta.name = '导出文件中的名称'
    changed.messages[0].content = 'changed old body'
    await writeFile(second, JSON.stringify(changed))
    const before = await fingerprint(sources)
    const started = performance.now(); application = await launch(); let page = await application.firstWindow()
    await expect(page.getByRole('button', { name: '导入会话', exact: true })).toBeVisible()
    console.info(`firstWindowReadyMs=${Math.round(performance.now()-started)}`)
    await page.getByRole('button',{name:'导入会话',exact:true}).click()
    await page.screenshot({ path: testInfo.outputPath('01-file-selection.png') })
    await save(page, first)
    await expect(page.getByText('已保存 3 条消息。', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: conversationTitle, exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('02-completed.png') })
    const initial = (await page.evaluate(() => window.whomi.listConversations({}))).items[0]
    await page.getByRole('button', { name: '打开会话', exact: true }).click()
    await expect(page.locator('.message-text').first()).toHaveText(malicious)
    expect(await page.evaluate(() => window.importExecuted)).toBeUndefined()
    expect(await page.locator('.message-text script, .message-text img').count()).toBe(0)
    await expect(page.getByRole('dialog', { name: '选择本人' })).toBeVisible()
    await page.locator('.reader-member-item input[type="radio"]').first().check()
    await page.getByRole('button', { name: '设为本人', exact: true }).click()
    await expect(page.locator('.message-self')).toHaveCount(3)
    await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    for (const name of ['Whomi 首页', '跳到主要内容']) {
      await page.evaluate(() => { location.hash = '' })
      const link = page.getByRole('link', { name, exact: true })
      await link.focus(); await link.click()
      await expect.poll(() => page.url().endsWith('#main-content')).toBe(true)
      expect(await page.evaluate(() => window.whomi.chooseSources('files'))).toEqual([])
      const afterNavigation = await page.evaluate(id => window.whomi.readMessages({ conversationId: id, direction: 'after' }), initial.id)
      expect(afterNavigation.items).toHaveLength(3)
      expect(afterNavigation.items.every(item => item.isSelf)).toBe(true)
    }
    await save(page, folder)
    await expect(page.getByText('新增 1 条消息，跳过 1 条重复消息', { exact: true })).toBeVisible()
    const matchedTitle = page.getByRole('heading', { name: '发现已有会话：示例联系人', exact: true })
    await expect(matchedTitle).toBeVisible()
    await expect(page.getByRole('heading', { name: '导出文件中的名称', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('matched-desktop.png') })
    await save(page, second)
    const duplicateCounts = page.getByText('没有新增消息，跳过 2 条重复消息', { exact: true })
    await expect(duplicateCounts).toBeVisible()
    const { normalSize, minimumSize } = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const normalSize = window.getSize()
      const minimumSize = window.getMinimumSize()
      window.setSize(...minimumSize)
      return { normalSize, minimumSize }
    })
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())).toEqual(minimumSize)
    await expect(matchedTitle).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('matched-narrow.png') })
    await page.getByRole('button', { name: '打开会话', exact: true }).click()
    await expect(page.getByRole('heading', { name: conversationTitle, exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回导入结果', exact: true }).click()
    await expect(matchedTitle).toBeVisible()
    await expect(duplicateCounts).toBeVisible()
    await page.getByRole('button', { name: '继续导入', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible()
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), normalSize)
    const beforeRestart = await page.evaluate(id => window.whomi.readMessages({ conversationId: id, direction: 'after' }), initial.id)
    const stableMessage = beforeRestart.items[2]
    expect(stableMessage.text).toBe('synthetic-3')
    await application.close(); application = await launch(); page = await application.firstWindow()
    const reopened = (await page.evaluate(() => window.whomi.listConversations({}))).items[0]
    expect(reopened.messageCount).toBe(4)
    await page.getByRole('button', { name: '展开会话列表', exact: true }).click()
    await page.getByRole('button', { name: reopened.title, exact: true }).click()
    await expect(page.locator('.message-text')).toHaveCount(4)
    expect(await page.locator('.message-text').allTextContents()).toEqual([malicious, 'synthetic-2', 'synthetic-3', 'synthetic-4'])
    const located = await page.evaluate(input => window.whomi.locateSource(input), { conversationId: initial.id, messageId: stableMessage.id })
    expect(located.status).toBe('available')
    expect(located.page.items.find(item => item.id === stableMessage.id)?.text).toBe(stableMessage.text)
    expect(await fingerprint(sources)).toBe(before)
  } finally { await application?.close(); await cleanup(directory) }
})

test('SIWX import retains unknown records and reports their saved state after reimport', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    const source = join(directory, 'synthetic-wechat.json')
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const records = [
      { localType: 1, content: '明晚见', serverId: '101' },
      { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>5</type></appmsg></msg>\n\0\0', content: '活动链接' },
      { localType: 42, content: '示例名片' },
      { localType: 50, content: '通话结束' },
      { localType: 49, rawContent: '<msg><appmsg><type>62</type></appmsg></msg>', content: '拍了拍示例联系人' },
      { localType: 49, content: '未识别的分享' },
      { localType: 11000, typeName: '类型11000', rawContent: '', content: '[类型11000]' },
      { localType: 49, rawContent: '<msg><appmsg><type>57</type><refermsg><svrid>101</svrid></refermsg></appmsg></msg>',
        content: '好的', quote: { content: '明晚见' } },
      { localType: 49, rawContent: '<msg><appmsg><type>36</type><url>https://example.invalid/app</url><weappinfo/></appmsg></msg>', content: '小程序分享' },
      { localType: 49, rawContent: '<msg><appmsg><type>76</type><url>https://example.invalid/music</url><songlyric/></appmsg></msg>', content: '音乐分享' },
      { localType: 49, rawContent: '<msg><appmsg><type>8</type></appmsg></msg>\n\0\0', content: '示例表情' },
    ]
    await writeFile(source, JSON.stringify({
      exportInfo: { exporter: 'SIWX', wxid: 'example-owner' },
      session: { wxid: 'example-peer', displayName: '合成微信会话', type: '私聊', messageCount: records.length },
      messages: records.map((record, index) => ({
        senderUsername: 'example-peer', senderDisplayName: '示例发送者', createTime: 1700000000 + index, ...record,
      })),
    }))
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    let stderr = ''
    application.process().stderr.on('data', chunk => { stderr += chunk })
    const diagnostics = () => stderr.split(/\r?\n/).slice(0, -1)
      .filter(line => line.startsWith('[导入诊断] '))
      .map(line => JSON.parse(line.slice('[导入诊断] '.length)))
    const expectedDiagnostic = {
      format: 'echotrace', unknownCount: 2, otherCount: 0,
      details: [
        { reason: '缺少应用消息子类型', type: 49, count: 1, firstRecord: 6 },
        { reason: '导出正文为类型占位', type: 11000, count: 1, firstRecord: 7 },
      ],
    }
    const page = await application.firstWindow()
    await save(page, source)
    await expect(page.getByText('已保存 11 条消息。', { exact: true })).toBeVisible()
    const typeWarning = page.getByText(/消息类型无法识别/)
    await expect(typeWarning).toHaveCount(0)
    await expect.poll(diagnostics).toEqual([expectedDiagnostic])
    await page.screenshot({ path: testInfo.outputPath('unknown-saved.png') })

    const [conversation] = (await page.evaluate(() => window.whomi.listConversations({}))).items
    const messages = (await page.evaluate(conversationId => window.whomi.readMessages({ conversationId, direction: 'after' }), conversation.id)).items
    expect(messages.map(message => message.kind)).toEqual(['text', 'link', 'contact', 'call', 'poke', 'unknown', 'unknown', 'reply', 'link', 'link', 'sticker'])
    expect(messages.map(message => message.text)).toEqual(records.map(record => record.content))
    expect(messages[7].reply.targetMessageId).toBe(messages[0].id)
    await page.getByRole('button', { name: '继续导入', exact: true }).click()
    await save(page, source)
    await expect(page.getByText('没有新增消息，跳过 11 条重复消息', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '发现已有会话：合成微信会话', exact: true })).toBeVisible()
    await expect(typeWarning).toHaveCount(0)
    await expect.poll(diagnostics).toEqual([expectedDiagnostic, expectedDiagnostic])
    const minimumSize = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const minimum = window.getMinimumSize()
      window.setSize(...minimum)
      return minimum
    })
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())).toEqual(minimumSize)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unknown-duplicate-narrow.png') })
    await page.getByRole('button', { name: '打开会话', exact: true }).click()
    await dismissIdentity(page)
    await expect(page.getByText('未识别的分享', { exact: true })).toBeVisible()
    await expect(page.getByText('[类型11000]', { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.whomi.listConversations({}))).items.map(item => [item.id, item.messageCount])).toEqual([[conversation.id, 11]])
  } finally { await application?.close(); await cleanup(directory) }
})

test('actual reader bounds six pages and preserves a visible anchor in both directions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-')); let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const source = join(directory, 'pages.json'); await writeFile(source, JSON.stringify(documentFor(Array.from({ length: 750 }, (_, i) => i + 1), 'Pagination synthetic')))
    application = await electron.launch({ ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }), env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const page = await application.firstWindow(); await save(page, source); await page.getByRole('button', { name: '打开会话', exact: true }).click()
    await dismissIdentity(page)
    for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: '加载后文', exact: true }).click(); await expect(page.locator('[data-message-id]')).toHaveCount((i + 2) * 100) }
    const geometry = () => page.locator('.reader-scroll').evaluate(container => {
      const bounds = container.getBoundingClientRect(), elements = [...container.querySelectorAll('[data-message-id]')]
      const anchor = elements.find(item => { const box = item.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom })
      return anchor ? { id: anchor.dataset.messageId, y: anchor.getBoundingClientRect().top - bounds.top } : null
    })
    for (const direction of ['后', '前']) {
      const anchorElement = page.locator('[data-message-id]').nth(direction === '后' ? 450 : 50)
      await anchorElement.evaluate(element => { const container = element.closest('.reader-scroll'); container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - 60; container.dispatchEvent(new Event('scroll')) })
      const before = await geometry(); expect(before).not.toBeNull()
      // dispatchEvent keeps the current viewport while exercising the real React handler.
      await page.getByRole('button', { name: `加载${direction}文`, exact: true }).dispatchEvent('click')
      await expect.poll(() => page.locator('[data-message-id]').first().getAttribute('data-message-id')).toBe(direction === '后' ? '101' : '1')
      await expect(page.locator('[data-message-id]')).toHaveCount(500)
      const position = await page.locator(`[data-message-id="${before.id}"]`).evaluate(element => element.getBoundingClientRect().top - element.closest('.reader-scroll').getBoundingClientRect().top)
      expect(Math.abs(position - before.y)).toBeLessThanOrEqual(2)
    }
  } finally { await application?.close(); await cleanup(directory) }
})

test('actual import selects recognized conversations, logs failures and returns to source selection after cancel', async ({}, testInfo) => {
  test.setTimeout(60000)
  const directory=await mkdtemp(join(tmpdir(),'whomi-runtime-'));let application
  let openedWithSystem = false
  try {
    const sources=join(directory,'sources')
    await mkdir(sources);await copyFile('tests/desktop/probe.cjs',join(directory,'probe.cjs'))
    const good=join(sources,'good.json'),broken=join(sources,'broken.json'), other=join(sources,'other.txt')
    await writeFile(good,JSON.stringify(documentFor([1],'Good synthetic')))
    await writeFile(broken,JSON.stringify(documentFor([2],'Second synthetic')))
    await writeFile(other,'Synthetic ordinary file')
    application=await electron.launch({args:[resolve('out/main/index.cjs'),'--whomi-runtime-test'],env:{...process.env,WHOMI_RUNTIME_TEST:directory}})
    const page=await application.firstWindow()
    await page.getByRole('button',{name:'导入会话',exact:true}).click();await drop(page,sources)
    await expect(page.getByRole('checkbox')).toHaveCount(2)
    await expect(page.getByRole('heading', { name: '选择要导入的会话' })).toBeVisible()
    const submit = page.getByRole('button', { name: '导入所选会话' })
    await expect(submit).toBeDisabled()
    await page.getByRole('checkbox', { name: /Good synthetic/ }).check()
    await expect(submit).toBeEnabled()
    await expect(page.getByText('other.txt')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('04-conversation-selection.png') })
    await page.getByRole('button',{name:'取消导入',exact:true}).click()
    await expect(page.getByRole('button',{name:'选择文件',exact:true})).toBeVisible()
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(0)
    await page.screenshot({ path: testInfo.outputPath('05-cancelled-restored.png'), animations: 'disabled' })
    await application.evaluate(({ shell }) => {
      const openPath = shell.openPath.bind(shell)
      shell.openPath = async path => {
        globalThis.openedImportLog = path
        if (!globalThis.useNativeLogOpen) return ''
        globalThis.nativeLogOpenResult = await openPath(path)
        return globalThis.nativeLogOpenResult
      }
    })
    await drop(page,other)
    const failure = page.getByRole('region', { name: '导入失败' })
    await expect(failure).toBeVisible()
    const notice = page.getByRole('region', { name: '异常提醒' })
    await expect(notice).toBeVisible()
    await expect(failure.getByRole('button')).toHaveCount(2)
    await failure.getByRole('button', { name: '查看错误日志' }).click()
    await expect.poll(() => application.evaluate(() => globalThis.openedImportLog)).toMatch(/import-errors.*\.txt$/)
    const logPath = await application.evaluate(() => globalThis.openedImportLog)
    expect(JSON.parse(await readFile(logPath, 'utf8'))).toMatchObject({ code: 'NO_IMPORTABLE_CONVERSATIONS', phase: 'scan' })
    await page.screenshot({ path: testInfo.outputPath('06-import-failure.png') })
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(0)
    await failure.getByRole('button', { name: '取消导入' }).click()
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible()
    await application.evaluate((_, useNative) => { globalThis.useNativeLogOpen = useNative; globalThis.openedImportLog = undefined }, process.env.WHOMI_DESKTOP_OPEN_LOG === '1')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '关于 Whomi', exact: true }).click()
    await page.getByRole('button', { name: '查看最近一次导入错误日志' }).click()
    await expect.poll(() => application.evaluate(() => globalThis.openedImportLog)).toBe(logPath)
    if (process.env.WHOMI_DESKTOP_OPEN_LOG === '1') {
      await expect.poll(() => application.evaluate(() => globalThis.nativeLogOpenResult)).toBe('')
      openedWithSystem = true
    }
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
    await drop(page,good)
    await expect(page.getByText('导入完成',{exact:true})).toBeVisible()
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('07-recovered.png') })
  } finally {
    await application?.close()
    try { await cleanup(directory) }
    catch (error) {
      if (!openedWithSystem || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error
      console.info(`The system log viewer is holding the synthetic profile: ${directory}`)
    }
  }
})

for (const [label, phase, code] of [
  ['会话统计更新失败', 'statistics', 'STATISTICS_FAILED'],
  ['无法确认保存结果', 'confirm', 'SAVE_CONFIRMATION_MISSING'],
]) {
  test(`controlled ${phase} failure rolls back a mixed import batch`, async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
    let application
    try {
      const sources = join(directory, 'batch')
      await mkdir(sources)
      await copyFile('tests/desktop/fixtures/import-recovery-probe.cjs', join(directory, 'probe.cjs'))
      const original = join(directory, 'before.json')
      const originalTitle = 'Existing 100 synthetic messages'
      await writeFile(original, JSON.stringify(documentFor(Array.from({ length: 100 }, (_, i) => i + 1), originalTitle)))
      await writeFile(join(sources, '01-append.json'), JSON.stringify(documentFor(Array.from({ length: 20 }, (_, i) => i + 101), originalTitle)))
      await writeFile(join(sources, '02-new.json'), JSON.stringify(documentFor([1, 2], 'New synthetic conversation')))
      application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
      const page = await application.firstWindow()
      await save(page, original)
      const getLibrary = () => page.evaluate(async () => (await window.whomi.listConversations({})).items)
      const initial = await getLibrary()
      expect(initial.map(item => [item.title, item.messageCount])).toEqual([[originalTitle, 100]])
      await application.evaluate(async (_, method) => { await globalThis.__whomiRuntimeProbe.request(`probe.fail-${method}`, null) }, phase)
      await application.evaluate(({ shell }) => { shell.openPath = async path => { globalThis.controlledLogPath = path; return '' } })
      await page.getByRole('button', { name: '继续导入', exact: true }).click()
      await drop(page, sources)
      await page.getByRole('checkbox', { name: new RegExp(originalTitle) }).check()
      await page.getByRole('checkbox', { name: /New synthetic conversation/ }).check()
      await page.getByRole('button', { name: '导入所选会话' }).click()
      const failure = page.getByRole('region', { name: '导入失败' })
      await expect(failure.getByRole('heading', { name: label })).toBeVisible()
      await expect(page.getByRole('button', { name: '打开会话' })).toHaveCount(0)
      expect(await getLibrary()).toEqual(initial)
      const notice = page.getByRole('region', { name: '异常提醒' })
      const disclosure = notice.getByRole('button', { name: '展开详情' })
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
      await disclosure.click()
      await expect(notice.getByRole('button', { name: '收起详情' })).toHaveAttribute('aria-expanded', 'true')
      await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(...window.getMinimumSize()) })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`controlled-${phase}-failure-narrow.png`) })
      await failure.getByRole('button', { name: '查看错误日志' }).click()
      await expect.poll(() => application.evaluate(() => globalThis.controlledLogPath)).toMatch(/import-errors.*\.txt$/)
      const path = await application.evaluate(() => globalThis.controlledLogPath)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ phase, code })
      await failure.getByRole('button', { name: '取消导入' }).click()
      await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
      await expect(page.getByRole('button', { name: '选择文件夹', exact: true })).toBeEnabled()
      expect(await getLibrary()).toEqual(initial)
      await page.screenshot({ path: testInfo.outputPath(`controlled-${phase}-cancelled.png`), animations: 'disabled' })
    } finally { await application?.close(); await cleanup(directory) }
  })
}

for (const sourceKind of ['file', 'folder']) {
  test(`controlled picker result cannot replace a dropped ${sourceKind}`, async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
    let application
    try {
      const sources = join(directory, 'dropped')
      await mkdir(sources)
      await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
      const dropped = join(sources, 'file.json'), late = join(directory, 'late.json')
      await writeFile(dropped, JSON.stringify(documentFor([1], 'Dropped synthetic conversation')))
      await writeFile(late, JSON.stringify(documentFor([2], 'Late synthetic conversation')))
      application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
      await application.evaluate(({ dialog }) => {
        dialog.showOpenDialog = (...args) => new Promise(resolve => { globalThis.controlledPicker = { count: args.length, resolve } })
      })
      const page = await application.firstWindow()
      await page.getByRole('button', { name: '导入会话', exact: true }).click()
      const choose = page.getByRole('button', { name: sourceKind === 'file' ? '选择文件' : '选择文件夹', exact: true })
      await choose.click()
      await expect.poll(() => application.evaluate(() => globalThis.controlledPicker?.count)).toBe(1)
      await drop(page, sourceKind === 'file' ? dropped : sources)
      await expect(page.getByText('导入完成', { exact: true })).toBeVisible()
      const canceled = sourceKind === 'folder'
      await application.evaluate((_, result) => { globalThis.controlledPicker.resolve(result) }, { canceled, filePaths: canceled ? [] : [late] })
      await expect(page.getByRole('heading', { name: 'Dropped synthetic conversation' })).toBeVisible()
      const library = await page.evaluate(async () => (await window.whomi.listConversations({})).items)
      expect(library.map(item => item.title)).toEqual(['Dropped synthetic conversation'])
      await page.screenshot({ path: testInfo.outputPath(`controlled-${sourceKind}-drop-completed.png`) })
    } finally { await application?.close(); await cleanup(directory) }
  })
}

test('actual large-file parsing shows real counts and can be cancelled', async ({}, testInfo) => {
  test.setTimeout(90000)
  const directory=await mkdtemp(join(tmpdir(),'whomi-runtime-'));let application
  try {
    const source=join(directory,'large.jsonl')
    await copyFile('tests/desktop/probe.cjs',join(directory,'probe.cjs'))
    const header={_type:'header',chatlab:fixture.chatlab,meta:{...fixture.meta,name:'Progress synthetic',groupId:'progress-synthetic'}}
    await writeFile(source,JSON.stringify(header)+'\n'+fixture.members.map(m=>JSON.stringify({_type:'member',...m})).join('\n')+'\n')
    for(let start=0;start<100000;start+=5000) {
      let batch=''
      for(let i=start;i<start+5000;i++)batch+=JSON.stringify({_type:'message',...fixture.messages[0],platformMessageId:String(i+1),timestamp:1700000000+i,content:`Synthetic parsing record ${i+1}`})+'\n'
      await appendFile(source,batch)
    }
    application=await electron.launch({args:[resolve('out/main/index.cjs'),'--whomi-runtime-test'],env:{...process.env,WHOMI_RUNTIME_TEST:directory}})
    const page=await application.firstWindow()
    await page.evaluate(()=>{window.syntheticStages=[];window.whomi.onImport(s=>window.syntheticStages.push({status:s.status,seen:s.counts.seen}))})
    await page.getByRole('button',{name:'导入会话',exact:true}).click();await drop(page,source)
    await expect.poll(()=>page.evaluate(()=>window.syntheticStages.some(s=>s.status==='staging' && s.seen>0))).toBe(true)
    const parsing=page.getByRole('region',{name:'解析进度',exact:true})
    await expect(parsing.getByRole('progressbar')).not.toHaveAttribute('value')
    await expect(parsing).toContainText(/已检查 [1-9][0-9]* 条记录/)
    await page.screenshot({ path: testInfo.outputPath('08-real-parsing.png') })
    await parsing.getByRole('button',{name:'取消导入',exact:true}).click()
    await expect(page.getByRole('button',{name:'选择文件',exact:true})).toBeVisible()
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(0)
    await page.screenshot({ path: testInfo.outputPath('09-parsing-cancelled.png') })
  }finally{await application?.close();await cleanup(directory)}
})

function launchImportWindow(directory) {
  return electron.launch({
    args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
    env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  })
}

async function captureWindow(application, path) {
  const png = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(path, Buffer.from(png, 'base64'))
}

test('same-name conversations can be selected by export folder', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const telegram = JSON.parse(await readFile('tests/fixtures/import/telegram-native-single/positive.json', 'utf8'))
    const sources = join(directory, 'sources')
    for (const [i, month] of ['十月', '十一月'].entries()) {
      const folder = join(sources, month)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'result.json'), JSON.stringify({ ...telegram, id: 330 + i, name: '项目组',
        messages: [{ ...telegram.messages[0], text: month + '的例会' }] }))
    }
    application = await launchImportWindow(directory)
    const page = await application.firstWindow()
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    await drop(page, sources)
    await page.getByRole('checkbox', { name: '项目组 十一月/result.json' }).check()
    await expect(page.getByRole('checkbox', { name: '项目组 十月/result.json' })).not.toBeChecked()
    await page.screenshot({ path: testInfo.outputPath('selected-november.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '导入所选会话' }).click()
    await expect(page.getByText('导入完成', { exact: true })).toBeVisible()
    const messages = await page.evaluate(async () => {
      const { items: conversations } = await window.whomi.listConversations({})
      return Promise.all(conversations.map(async ({ id }) =>
        (await window.whomi.readMessages({ conversationId: id, direction: 'after' })).items.map(message => message.text)))
    })
    expect(messages).toEqual([['十一月的例会']])
  } finally { await application?.close(); await cleanup(directory) }
})

test('interrupted selection exposes the original log on restart before entering import', async ({}, testInfo) => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const folder = join(directory, 'sources')
    await mkdir(folder)
    await writeFile(join(folder, 'first.json'), JSON.stringify(documentFor([1, 2], 'First conversation')))
    await writeFile(join(folder, 'second.json'), JSON.stringify(documentFor([3, 4], 'Second conversation')))
    application = await launchImportWindow(directory)
    let page = await application.firstWindow()
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    await drop(page, folder)
    await expect(page.getByRole('heading', { name: '选择要导入的会话' })).toBeVisible()
    await application.close()

    application = await launchImportWindow(directory)
    page = await application.firstWindow()
    // 记录应用交给系统文本查看器的文件，以便核对原始内容与身份。
    await application.evaluate(({ shell }) => {
      globalThis.openedImportLogs = []
      shell.openPath = async path => { globalThis.openedImportLogs.push(path); return '' }
    })
    const button = name => page.getByRole('button', { name, exact: true })
    const notices = page.getByRole('region', { name: '异常提醒' })
    await expect(page.locator('.app-shell:not(.startup-running) .hello-cover .greeting')).toBeVisible({ timeout: 15000 })
    await button('设置').click({ trial: true })
    await expect(notices.getByRole('alert')).toHaveText('导入遇到问题')
    await captureWindow(application, testInfo.outputPath('interrupted-home.png'))
    await button('设置').click()
    await button('关于 Whomi').click()
    await button('查看最近一次导入错误日志').click()
    const opened = () => application.evaluate(() => globalThis.openedImportLogs)
    await expect.poll(opened).toHaveLength(1)
    const [first] = await opened()
    expect(JSON.parse(await readFile(first, 'utf8'))).toMatchObject({
      phase: 'parse', code: 'INTERRUPTED', counts: { seen: 4, validRecords: 4, invalidRecords: 0 },
    })
    await button('返回').click()
    await button('导入会话').click()
    await button('查看错误日志').click()
    await expect.poll(opened).toEqual([first, first])
    expect((await readdir(dirname(first))).filter(name => name.endsWith('.txt'))).toEqual([basename(first)])
    await button('取消导入').click()
    await expect(button('选择文件')).toBeEnabled()
    await expect(notices).toHaveCount(0)
  } finally { await application?.close(); await cleanup(directory) }
})

test('restart recovers a scan when the window never received its job number', async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const file = join(directory, 'scan.json')
    await writeFile(file, JSON.stringify(documentFor([1], 'Interrupted scan')))
    application = await launchImportWindow(directory)
    let page = await application.firstWindow()
    await application.evaluate(({ ipcMain }) => {
      // 模拟扫描请求已经写库，但窗口退出前未收到回复。
      const original = ipcMain._invokeHandlers.get('whomi:call')
      ipcMain.removeHandler('whomi:call')
      ipcMain.handle('whomi:call', async (event, request) => {
        const result = await original(event, request)
        if (request.method === 'prepareImport' && result.ok) {
          globalThis.preparedWithoutReply = true
          return new Promise(() => {})
        }
        return result
      })
    })
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    await drop(page, file)
    await expect.poll(() => application.evaluate(() => globalThis.preparedWithoutReply)).toBe(true)
    expect(await page.evaluate(() => localStorage.getItem('whomi:import-job'))).toBeNull()
    await application.close()
    application = await launchImportWindow(directory)
    page = await application.firstWindow()
    const notices = page.getByRole('region', { name: '异常提醒' })
    await expect(notices.getByRole('alert')).toHaveText('导入遇到问题')
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    await expect(page.getByRole('button', { name: '查看错误日志' })).toBeEnabled()
    await page.getByRole('button', { name: '取消导入' }).click()
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
    await expect(notices).toHaveCount(0)
  } finally { await application?.close(); await cleanup(directory) }
})

test('picker failure survives settings and navigation and the next selection stays unique', async ({}, testInfo) => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const file = join(directory, 'sample.json')
    await writeFile(file, JSON.stringify(documentFor([1], 'Selected once')))
    application = await launchImportWindow(directory)
    const page = await application.firstWindow()
    const button = name => page.getByRole('button', { name, exact: true })
    const notices = page.getByRole('region', { name: '异常提醒' })
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => { throw Error('Synthetic picker failure') }
    })
    await button('导入会话').click()
    await button('选择文件').click()
    await expect(page.getByRole('heading', { name: '无法打开选择窗口' })).toBeVisible()
    await button('设置').click()
    await expect(notices.getByRole('alert')).toHaveText('导入遇到问题')
    await button('个人总览').click()
    await expect(notices).toBeVisible()
    await button('导入会话').click()
    await expect(button('查看错误日志')).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('restored-source-failure.png'), animations: 'disabled' })
    await button('取消导入').click()
    await expect(notices).toHaveCount(0)
    await application.evaluate(({ dialog }) => {
      globalThis.pendingPickers = []
      dialog.showOpenDialog = () => new Promise(resolve => globalThis.pendingPickers.push(resolve))
    })
    await button('选择文件').click()
    await button('导入会话').click()
    await expect(button('选择文件')).toBeDisabled()
    expect(await application.evaluate(() => globalThis.pendingPickers.length)).toBe(1)
    await application.evaluate((_, path) => globalThis.pendingPickers[0]({ canceled: false, filePaths: [path] }), file)
    await expect(page.getByText('导入完成', { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.whomi.listConversations({}))).items.map(item => item.title)).toEqual(['Selected once'])
  } finally { await application?.close(); await cleanup(directory) }
})

test('compact navigation lets keyboard users expand an import error and return to navigation', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const file = join(directory, 'unrecognized.txt')
    await writeFile(file, 'Synthetic unrecognized export')
    application = await launchImportWindow(directory)
    const page = await application.firstWindow()
    await page.getByRole('button', { name: '导入会话', exact: true }).click()
    await drop(page, file)
    await expect(page.getByRole('region', { name: '导入失败' })).toBeVisible()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(640)
    const navigation = page.getByRole('dialog', { name: '导航面板' })
    if (!(await navigation.isVisible())) await page.getByRole('button', { name: '展开侧栏' }).click()
    await navigation.getByRole('link', { name: 'Whomi 首页' }).focus()
    const show = page.getByRole('button', { name: '展开详情' })
    const focused = selector => selector.evaluate(element => element === document.activeElement)
    for (let i = 0; i < 20 && !await focused(show); i++) await page.keyboard.press('Tab')
    await expect(show).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '收起详情' })).toBeFocused()
    await captureWindow(application, testInfo.outputPath('compact-keyboard-notice.png'))
    await page.keyboard.press('Tab')
    expect(await navigation.evaluate(panel => panel.contains(document.activeElement) &&
      !document.activeElement.closest('[data-exception-notices]'))).toBe(true)
  } finally { await application?.close(); await cleanup(directory) }
})
