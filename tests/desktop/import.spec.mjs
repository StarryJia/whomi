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
  const box = await page.getByRole('button', { name: '选择文件', exact: true }).boundingBox()
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: [path], dragOperationsMask: 1 }, point = { x: box.x + box.width / 2, y: box.y + box.height / 2, data }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point })
  await cdp.detach()
}
async function save(page, path) {
  await page.getByRole('button', { name: '导入会话', exact: true }).click()
  await drop(page, path)
  await expect(page.getByText('导入完成。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('导入目标', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '预览消息', exact: true })).toHaveCount(0)
}
async function cleanup(directory) {
  const actual = await realpath(directory)
  if (dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('whomi-runtime-')) throw new Error('Unexpected test directory')
  await rm(actual, { recursive: true, force: true })
}
test('actual import UI preserves old messages, self identity, source bytes and stable locations after restart', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  const sources = join(directory, 'sources'), folder = join(sources, 'new-computer')
  const launch = () => electron.launch({ ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }), env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  let application
  try {
    await mkdir(folder, { recursive: true }); await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const first = join(sources, 'first.json'), second = join(folder, 'second.json')
    await writeFile(first, JSON.stringify(documentFor([1,2,3])))
    const changed = documentFor([2,4]); changed.messages[0].content = 'changed old body'
    await writeFile(second, JSON.stringify(changed))
    const before = await fingerprint(sources)
    const started = performance.now(); application = await launch(); let page = await application.firstWindow()
    await expect(page.getByRole('button', { name: '导入会话', exact: true })).toBeVisible()
    console.info(`firstWindowReadyMs=${Math.round(performance.now()-started)}`)
    const evidence=resolve('release/auto-import-20261031');await mkdir(evidence,{recursive:true})
    await page.getByRole('button',{name:'导入会话',exact:true}).click()
    await page.screenshot({path:join(evidence,'01-file-selection.png')})
    await save(page, first)
    await expect(page.getByText('已保存 3 条消息。', { exact: true })).toBeVisible()
    await page.screenshot({path:join(evidence,'02-completed.png')})
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
    await page.setViewportSize({width:960,height:720})
    await page.screenshot({path:join(evidence,'03-completed-narrow.png')})
    await page.setViewportSize(viewport)
    const initial = (await page.evaluate(() => window.whomi.listConversations({}))).items[0]
    await page.getByRole('button', { name: '打开会话', exact: true }).click()
    await expect(page.locator('.message-text').first()).toHaveText(malicious)
    expect(await page.evaluate(() => window.importExecuted)).toBeUndefined()
    expect(await page.locator('.message-text script, .message-text img').count()).toBe(0)
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '选择本人', exact: true }).click()
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
    await expect(page.getByText('已保存 1 条消息。', { exact: true })).toBeVisible()
    await save(page, second)
    await expect(page.getByText('新增 0 条消息，重复 2 条。', { exact: true })).toBeVisible()
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

test('actual reader bounds six pages and preserves a visible anchor in both directions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-')); let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const source = join(directory, 'pages.json'); await writeFile(source, JSON.stringify(documentFor(Array.from({ length: 750 }, (_, i) => i + 1), 'Pagination synthetic')))
    application = await electron.launch({ ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }), env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const page = await application.firstWindow(); await save(page, source); await page.getByRole('button', { name: '打开会话', exact: true }).click()
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

test('actual import cancels before saving and retains partial results for recovery',async()=>{
  test.setTimeout(60000)
  const directory=await mkdtemp(join(tmpdir(),'whomi-runtime-'));let application
  try {
    const sources=join(directory,'sources'),evidence=resolve('release/auto-import-20261031')
    await mkdir(sources);await mkdir(evidence,{recursive:true});await copyFile('tests/desktop/probe.cjs',join(directory,'probe.cjs'))
    const good=join(sources,'good.json'),broken=join(sources,'broken.json')
    await writeFile(good,JSON.stringify(documentFor([1],'Good synthetic')))
    await writeFile(broken,JSON.stringify({...documentFor([2],'Broken synthetic'),messages:[null]}))
    application=await electron.launch({args:[resolve('out/main/index.cjs'),'--whomi-runtime-test'],env:{...process.env,WHOMI_RUNTIME_TEST:directory}})
    const page=await application.firstWindow()
    await page.getByRole('button',{name:'导入会话',exact:true}).click();await drop(page,sources)
    await expect(page.getByRole('checkbox')).toHaveCount(2)
    await page.screenshot({path:join(evidence,'04-entry-selection.png')})
    await page.getByRole('button',{name:'取消导入',exact:true}).click()
    await expect(page.getByRole('button',{name:'选择文件',exact:true})).toBeVisible()
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(0)
    await page.screenshot({path:join(evidence,'05-cancelled-restored.png')})
    await drop(page,sources)
    await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check()
    await page.getByRole('button',{name:'解析所选入口',exact:true}).click()
    await expect(page.getByText('部分会话未完成，请查看下方结果。',{exact:true})).toBeVisible()
    await expect(page.getByText('已保存 1 条消息。',{exact:true})).toBeVisible()
    await expect(page.getByRole('button',{name:'打开会话',exact:true})).toHaveCount(1)
    await page.screenshot({path:join(evidence,'06-partial-failure.png')})
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(1)
    await writeFile(broken,JSON.stringify(documentFor([2],'Broken synthetic')))
    await page.getByRole('button',{name:'继续导入',exact:true}).click();await drop(page,broken)
    await expect(page.getByText('导入完成。',{exact:true})).toBeVisible()
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(2)
    await page.screenshot({path:join(evidence,'07-recovered.png')})
  }finally{await application?.close();await cleanup(directory)}
})

test('actual large-file parsing shows real counts and can be cancelled',async()=>{
  test.setTimeout(90000)
  const directory=await mkdtemp(join(tmpdir(),'whomi-runtime-'));let application
  try {
    const source=join(directory,'large.jsonl'),evidence=resolve('release/auto-import-20261031')
    await mkdir(evidence,{recursive:true});await copyFile('tests/desktop/probe.cjs',join(directory,'probe.cjs'))
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
    await page.screenshot({path:join(evidence,'08-real-parsing.png')})
    await parsing.getByRole('button',{name:'取消导入',exact:true}).click()
    await expect(page.getByRole('button',{name:'选择文件',exact:true})).toBeVisible()
    expect((await page.evaluate(()=>window.whomi.listConversations({}))).items).toHaveLength(0)
    await page.screenshot({path:join(evidence,'09-parsing-cancelled.png')})
  }finally{await application?.close();await cleanup(directory)}
})
