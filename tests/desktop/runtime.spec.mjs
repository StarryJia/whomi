import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, copyFile, symlink, rmdir, unlink, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const boundary of ['main', 'data']) test(`rejects a test directory junction at the ${boundary} boundary without opening its target database`, async () => {
  const target = await mkdtemp(resolve('.whomi-runtime-target-'))
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  let linked = false
  let validDirectory
  try {
    const database = new Database(join(target, 'whomi.db'))
    database.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('untouched')")
    database.close()
    await copyFile('tests/desktop/probe.cjs', join(target, 'probe.cjs'))
    const before = await readFile(join(target, 'whomi.db'))
    const files = (await readdir(target)).sort()
    await rmdir(directory)
    await symlink(target, directory, 'junction')
    linked = true
    let started = false
    if (boundary === 'main') try {
      application = await electron.launch({
        ...(process.env.WHOMI_PACKAGED_EXECUTABLE
          ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
          : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
        env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
        timeout: 10000,
      })
      await application.firstWindow()
    } catch {}
    if (boundary === 'main') started = Boolean(application)
    else {
      validDirectory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
      await copyFile('tests/desktop/probe.cjs', join(validDirectory, 'probe.cjs'))
      application = await electron.launch({
        ...(process.env.WHOMI_PACKAGED_EXECUTABLE
          ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
          : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
        env: { ...process.env, WHOMI_RUNTIME_TEST: validDirectory },
      })
      await application.firstWindow()
      started = await application.evaluate(async ({ app, utilityProcess }, linkedDirectory) => {
        const { dirname, join } = process.getBuiltinModule('node:path')
        const entry = app.isPackaged ? join(app.getAppPath(), 'out/main/data/entry.cjs') : join(dirname(process.argv[1]), 'data/entry.cjs')
        const child = utilityProcess.fork(entry, [linkedDirectory, '--runtime-probe'])
        return new Promise(resolve => {
          child.once('exit', () => resolve(false))
          child.once('message', () => { child.kill(); resolve(true) })
          child.postMessage({ id: 1, method: 'health', payload: null })
        })
      }, directory)
    }
    await application?.close()
    application = undefined
    expect.soft(started).toBe(false)
    expect.soft((await readdir(target)).sort()).toEqual(files)
    expect(await readFile(join(target, 'whomi.db'))).toEqual(before)
  } finally {
    await application?.close()
    if (linked) await unlink(directory)
    else await rm(directory, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
    if (validDirectory) await rm(validDirectory, { recursive: true, force: true })
  }
})

test('saved data survives a restart while the renderer stays isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
  const launch = () => electron.launch({
    ...(process.env.WHOMI_PACKAGED_EXECUTABLE
      ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
      : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
    env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  })
  let application
  try {
    application = await launch()
    const page = await application.firstWindow()
    await expect(page.locator('main')).toBeAttached()
    expect(await page.evaluate(() => typeof window.require !== 'undefined' || typeof window.process !== 'undefined')).toBe(false)
    const health = await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('health', null))
    expect(health.writable).toBe(true)
    console.info(`runtime=${health.runtime} sqlite=${health.sqliteVersion} writable=${health.writable}`)
    const [major, minor, patch] = health.sqliteVersion.split('.').map(Number)
    expect(major * 1000000 + minor * 1000 + patch).toBeGreaterThanOrEqual(3051003)
    await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.write', null))
    await application.close()
    application = await launch()
    await application.firstWindow()
    expect(await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.read', null))).toBe('saved')
    await expect(application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('unknown', null))).rejects.toThrow()
    await expect(application.evaluate(async () => {
      const pending = globalThis.__whomiRuntimeProbe.request('probe.pending', null)
      await globalThis.__whomiRuntimeProbe.close()
      return pending
    })).rejects.toThrow()
  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

for (const boundary of ['Before','After']) test(`crash recovery after actual import exits ${boundary} COMMIT`,async()=> {
  const directory=await mkdtemp(join(tmpdir(),'whomi-runtime-'))
  await copyFile('tests/desktop/import-probe.cjs',join(directory,'probe.cjs'))
  await copyFile('tests/fixtures/import/chatlab/positive.json',join(directory,'source.json'))
  const launch=()=>electron.launch({args:[resolve('out/main/index.cjs'),'--whomi-runtime-test'],env:{...process.env,WHOMI_RUNTIME_TEST:directory}})
  let application
  try {
    application=await launch();const page=await application.firstWindow()
    expect(await page.evaluate(()=>typeof window.require!=='undefined'||typeof window.process!=='undefined')).toBe(false)
    await expect(application.evaluate(async(_electron,boundary)=>globalThis.__whomiRuntimeProbe.request(`probe.crash${boundary}`,null),boundary)).rejects.toThrow()
    await application.close();application=await launch();await application.firstWindow()
    const recovered=await application.evaluate(async()=>globalThis.__whomiRuntimeProbe.request('probe.recovered',null))
    expect(recovered.integrity).toBe('ok')
    expect(recovered.count).toBe(boundary==='Before' ? 0:2)
    expect(recovered.snapshot.status).toBe(boundary==='Before' ? 'failed':'completed')
    if(boundary==='After') {
      expect(recovered.snapshot.results[0].status).toBe('saved')
      const retry=await application.evaluate(async()=>globalThis.__whomiRuntimeProbe.request('probe.reimport',null))
      expect(retry.inserted).toBe(0);expect(retry.duplicates).toBe(2)
    }
  }finally {await application?.close();await rm(directory,{recursive:true,force:true})}
})

test('desktop bridge accepts genuine disk files and directory drops and keeps the renderer isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  try {
    await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
    const source = join(directory, 'source.json'), folder = join(directory, 'exports')
    await copyFile('tests/fixtures/import/chatlab/positive.json', source); await mkdir(folder)
    await copyFile(source, join(folder, 'conversation.json'))
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const page = await application.firstWindow()
    expect(await page.evaluate(() => typeof window.whomi?.prepareImport)).toBe('function')
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'actual-file'; document.body.append(input)
      input.addEventListener('change', async () => { window.accepted = await window.whomi.acceptDroppedFiles(Array.from(input.files)) })
      const drop = document.createElement('div'); drop.id = 'actual-drop'; drop.style.cssText = 'position:fixed;inset:0;z-index:999999;background:white'; document.body.append(drop)
      drop.addEventListener('dragover', event => event.preventDefault())
      drop.addEventListener('drop', async event => { event.preventDefault(); window.dropped = await window.whomi.acceptDroppedFiles(Array.from(event.dataTransfer.files)) })
    })
    await page.locator('#actual-file').setInputFiles(source)
    await expect.poll(() => page.evaluate(() => window.accepted?.length)).toBe(1)
    const accepted = await page.evaluate(() => window.accepted)
    expect(accepted[0]).toMatchObject({ displayName: 'source.json', kind: 'file' }); expect(JSON.stringify(accepted)).not.toContain(directory)
    const id = await page.evaluate(() => window.whomi.prepareImport(window.accepted))
    expect(typeof id).toBe('string')
    expect(await page.evaluate(id => window.whomi.getImport(id), id)).toMatchObject({ status: 'awaiting_confirmation' })
    await page.evaluate(id => window.whomi.cancelImport(id), id)
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files: [folder], dragOperationsMask: 1 }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 50, y: 50, data })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: 50, y: 50, data })
    await expect.poll(() => page.evaluate(() => window.dropped?.length)).toBe(1)
    expect(await page.evaluate(() => window.dropped[0].kind)).toBe('directory')
    const directoryId = await page.evaluate(() => window.whomi.prepareImport(window.dropped))
    const discovered = await page.evaluate(id => window.whomi.getImport(id), directoryId)
    expect(discovered.discovery.entries).toHaveLength(1)
    await page.evaluate(async ({ id, entryIds }) => {
      window.importEvents = []; window.stopImportEvents = window.whomi.onImport(snapshot => window.importEvents.push(snapshot.status))
      await window.whomi.startImport({ kind: 'stage', jobId: id, entryIds })
    }, { id: directoryId, entryIds: discovered.discovery.entries.map(entry => entry.entryId) })
    await expect.poll(() => page.evaluate(async id => (await window.whomi.getImport(id)).status, directoryId)).toBe('awaiting_commit')
    const candidate = (await page.evaluate(id => window.whomi.getImport(id), directoryId)).candidates[0]
    expect((await page.evaluate(({ id, candidateId }) => window.whomi.previewImport(id, candidateId, { limit: 1 }), { id: directoryId, candidateId: candidate.candidateId })).messages).toHaveLength(1)
    const eventCount = await page.evaluate(async id => {
      window.stopImportEvents(); const count = window.importEvents.length
      await window.whomi.startImport({ kind: 'commit', plan: { jobId: id, decisions: [] } }); return count
    }, directoryId)
    await expect.poll(() => page.evaluate(async id => (await window.whomi.getImport(id)).status, directoryId)).toBe('completed')
    expect(await page.evaluate(() => window.importEvents.length)).toBe(eventCount)
    const conversations = await page.evaluate(() => window.whomi.listConversations({}))
    expect(conversations.items).toHaveLength(1)
    const conversationId = conversations.items[0].id
    const messages = await page.evaluate(conversationId => window.whomi.readMessages({ conversationId, direction: 'after' }), conversationId)
    expect(messages.items).toHaveLength(2)
    expect((await page.evaluate(input => window.whomi.locateSource(input), { conversationId, messageId: messages.items[0].id })).status).toBe('available')
    expect((await page.evaluate(id => window.whomi.listMembers(id), conversationId)).length).toBeGreaterThan(0)
    await page.evaluate(async id => { await window.whomi.confirmSelf(id, null); await window.whomi.retrySummary(id) }, conversationId)
    expect(await page.evaluate(async () => {
      const results = []
      for (const files of [[new File(['{}'], 'fake.json')], [new Blob(['{}'])], [{ path: 'C:/private.json' }]]) {
        try { await window.whomi.acceptDroppedFiles(files); results.push('accepted') } catch (error) { results.push(error.code) }
      }
      return results
    })).toEqual(['INVALID_SOURCE', 'INVALID_SOURCE', 'INVALID_SOURCE'])
    const boundaryPreload = join(directory, 'boundary-preload.cjs')
    await writeFile(boundaryPreload, `
      const {contextBridge,ipcRenderer}=require('electron');
      let filesystemAvailable=false;try {require('node:fs');filesystemAvailable=true}catch{}
      window.preloadOnlyMarker='isolated';
      contextBridge.exposeInMainWorld('__runtimeBoundaryProbe',{
        sandboxed:process.sandboxed,filesystemAvailable,
        run:()=>Promise.all([
          ipcRenderer.invoke('whomi:call',{method:'sql',args:['select 1']}),
          ipcRenderer.invoke('whomi:drop',{credential:'forged',paths:['C:/private.json']}),
          ipcRenderer.invoke('whomi:call',{method:'prepareImport',args:[[{token:'fake',displayName:'x',kind:'file',rootPath:'C:/private.json'}]]}),
          ipcRenderer.invoke('whomi:call',{method:'getImport',args:['01']})
        ])
      });
    `)
    await application.evaluate(({ session }, filePath) => session.defaultSession.registerPreloadScript({ type: 'frame', filePath }), boundaryPreload)
    await page.reload()
    expect(await page.evaluate(() => ({ sandboxed: window.__runtimeBoundaryProbe.sandboxed, filesystemAvailable: window.__runtimeBoundaryProbe.filesystemAvailable, marker: window.preloadOnlyMarker }))).toEqual({ sandboxed: true, filesystemAvailable: false, marker: undefined })
    const rejected = await page.evaluate(() => window.__runtimeBoundaryProbe.run())
    expect(rejected.map(response => response.error.code)).toEqual(['INVALID_METHOD', 'INVALID_SOURCE', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'])
    expect(rejected.every(response => Object.keys(response.error).sort().join(',') === 'action,code')).toBe(true)
    const foreign = await application.evaluate(async ({ BrowserWindow }, { filePath, url }) => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: filePath, contextIsolation: true, sandbox: true, nodeIntegration: false } })
      try { await window.loadURL(url); return await window.webContents.executeJavaScript('window.__runtimeBoundaryProbe.run()') }
      finally { window.destroy() }
    }, { filePath: boundaryPreload, url: page.url() })
    expect(foreign.every(response => response.error.code === 'UNTRUSTED_CALLER')).toBe(true)
    const previousUrl = page.url()
    await page.evaluate(() => { location.href = 'https://example.invalid/'; window.open('https://example.invalid/') })
    await expect.poll(() => application.windows().length).toBe(1)
    expect(page.url()).toBe(previousUrl)
    expect(await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, invoke: typeof window.whomi.invoke, frozen: Object.isFrozen(window.whomi) }))).toEqual({ node: 'undefined', process: 'undefined', invoke: 'undefined', frozen: true })
    await application.close(); application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const restarted = await application.firstWindow()
    expect(await restarted.evaluate(id => window.whomi.getImport(id), directoryId)).toMatchObject({ status: 'completed', inserted: 2 })
    expect(await restarted.evaluate(async ({ id, candidateId }) => { try { await window.whomi.previewImport(id, candidateId, {}); return 'available' } catch (error) { return error.code } }, { id: directoryId, candidateId: candidate.candidateId })).toBe('PREVIEW_UNAVAILABLE')
  } finally { await application?.close(); await rm(directory, { recursive: true, force: true }) }
})
