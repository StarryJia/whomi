import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { access as fileAccess, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const invoke = promisify(execFile)
const explorerScript = fileURLToPath(new URL('./fixtures/windows-explorer.ps1', import.meta.url))
const accessScript = fileURLToPath(new URL('./fixtures/windows-log-access.ps1', import.meta.url))

test('Windows data storage and import use installation logs across data changes and write permission failures', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Requires Windows file permissions.')
  test.setTimeout(120_000)
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'whomi-runtime-error-logs-')))
  const dataRoot = resolve('release/desktop-log-fixtures')
  await mkdir(dataRoot, { recursive: true })
  const data = await realpath(await mkdtemp(join(dataRoot, 'feedback-')))
  const source = join(profile, 'synthetic-broken-export.json')
  const packaged = process.env.WHOMI_PACKAGED_EXECUTABLE
  const install = packaged ? await realpath(await mkdtemp(join(tmpdir(), 'whomi-test-log-install-'))) : profile
  const logs = join(install, 'logs')
  const executablePath = packaged ? join(install, basename(packaged)) : undefined
  const privateMarker = 'SYNTHETIC-CHAT-AND-CREDENTIAL'
  let app, page, restoreAccess = false, nativeFolderPending = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const content = JSON.parse(body).messages.at(-1).content
      const instruction = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('')
      let payload
      try { payload = JSON.parse(instruction) } catch { /* Model connection probe uses plain text. */ }
      if (!payload?.stage) {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: privateMarker } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const result = JSON.stringify({ observations: [], openThreads: [], candidates: [] })
      response.end(`data: ${JSON.stringify({ id: 'log-fixture', choices: [{ index: 0, delta: { content: result }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'log-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: payload.stage === 'writing' ? 33_000 : 25 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const button = name => page.getByRole('button', { name, exact: true })
  async function launch() {
    app = await electron.launch({ executablePath, args: executablePath ? ['--whomi-runtime-test'] : [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: profile } })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await app.evaluate(({ shell, dialog }, { file, nativeFolder }) => {
      globalThis.logOpens = []
      const open = shell.openPath
      shell.openPath = async path => {
        const result = path === nativeFolder ? await open(path) : ''
        globalThis.logOpens.push({ path, result })
        return result
      }
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, { file: source, nativeFolder: nativeFolderPending ? logs : null })
  }
  async function openStorage() {
    await button('设置').click()
    await button('关于 Whomi').click()
    await expect(page.getByRole('region', { name: '关于 Whomi', exact: true }).getByRole('button', { name: /日志/ })).toHaveCount(0)
    await button('数据存储').click()
    const storage = page.getByRole('region', { name: '数据存储', exact: true })
    await expect(storage.getByRole('button', { name: /^打开.*日志/ })).toHaveCount(1)
    await expect(storage.getByRole('button', { name: '打开错误日志目录', exact: true })).toBeVisible()
  }
  const lastOpen = () => app.evaluate(() => globalThis.logOpens.at(-1))
  async function confirmFolder(expected) {
    await expect.poll(lastOpen).toEqual({ path: expected, result: '' })
    expect((await stat(expected)).isDirectory()).toBe(true)
    if (nativeFolderPending) {
      const { stdout } = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', explorerScript, '-Directory', expected], { windowsHide: true, timeout: 25_000 })
      expect(stdout.trim()).toBe(expected)
      nativeFolderPending = false
    }
  }
  const access = action => invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', accessScript, '-Directory', logs, '-Action', action], { windowsHide: true, timeout: 12_000 })
  try {
    if (packaged) {
      const distribution = dirname(resolve(packaged))
      await cp(distribution, install, { recursive: true, filter: path => path !== join(distribution, 'logs') })
    }
    await writeFile(join(profile, 'probe.cjs'), `module.exports = writer => async method => {
      if (method !== 'probe.logConversation') throw Error('Unsupported log fixture')
      writer.exec(\`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'合成日志会话','direct',0);
        INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','logs');
        INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'self','示例本人');
        INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
        INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms,time_precision)
          VALUES(1,1,1,'member','示例本人','text','${privateMarker}',0,1795000000000,'minute');\`)
      writer.pragma('wal_checkpoint(TRUNCATE)')
      return true
    }`)
    await writeFile(source, '{"incomplete":')
    nativeFolderPending = process.env.WHOMI_DESKTOP_VERIFY_EXPLORER === '1'
    await launch()
    await openStorage()
    await button('打开错误日志目录').click()
    await confirmFolder(logs)
    expect(await readdir(logs)).toEqual(['operations'])
    if (packaged) expect(await app.evaluate(() => process.execPath)).toBe(executablePath)
    await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.logConversation', null))
    await app.close(); app = undefined
    await copyFile(join(profile, 'whomi.db'), join(data, 'whomi.db'))
    await writeFile(join(profile, 'storage-location.json'), JSON.stringify({ version: 1, path: data, hasDatabase: true }))
    const previousDataLogs = join(data, 'logs')
    await mkdir(previousDataLogs)
    await writeFile(join(previousDataLogs, 'older-model.json'), '{}')
    await mkdir(join(profile, 'import-errors'))
    await writeFile(join(profile, 'import-errors', '1700000000000-12345678-1234-4123-8123-123456789012-none.txt'),
      JSON.stringify({ recordedAt: '2023-11-14T22:13:20.000Z', version: '0.1.10', phase: 'parse', code: 'INVALID_FORMAT' }))
    await launch()
    expect(await page.evaluate(() => window.whomi.listConversations({}))).toMatchObject({ items: [{ id: '1' }] })
    const modelId = await page.evaluate(async ({ url, key }) => {
      const service = await window.whomi.settings.saveProvider({ name: '合成错误服务', baseUrl: url, apiKey: key, enabled: true })
      return (await window.whomi.settings.saveModel({ providerId: service.id, label: '合成错误模型', model: 'test-model', contextWindow: 16000, maxTokens: 1000, enabled: true })).id
    }, { url: `http://127.0.0.1:${server.address().port}/v1`, key: privateMarker })
    await expect(page.evaluate(id => window.whomi.settings.testModel(id), modelId)).rejects.toThrow()
    const taskId = await page.evaluate(async modelId => {
      try {
        const preparation = await window.whomi.ai.prepareAnalysis({ conversationId: '1', modelId })
        return (await window.whomi.ai.confirmAnalysis({ token: preparation.token, requestId: 'insight-budget-log' })).id
      } catch (failure) { throw new Error(failure.code + ' ' + failure.action) }
    }, modelId)
    await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), taskId), { timeout: 20_000 })
      .toMatchObject({ state: 'failed', analyzedMessages: 1, error: expect.stringContaining('已达到洞察预算') })
    await button('导入会话').click()
    await button('选择文件').click()
    const failure = page.getByRole('region', { name: '导入失败' })
    await expect(failure).toBeVisible()
    const importJob = await page.evaluate(() => localStorage.getItem('whomi:import-job'))
    await failure.getByRole('button', { name: '查看错误日志' }).click()
    await expect.poll(lastOpen).toMatchObject({ path: expect.stringMatching(/operations.*\.txt$/), result: '' })
    const directLog = (await lastOpen()).path
    expect(dirname(directLog)).toBe(join(logs, 'operations'))
    await writeFile(info.outputPath('log-locations.json'), JSON.stringify({ executablePath, install, profile, data, logs, directLog }, null, 2))
    expect(await readFile(directLog, 'utf8')).toContain('任务编号=' + importJob)
    await app.close(); app = undefined
    await launch()
    await openStorage()
    await button('打开错误日志目录').click()
    await confirmFolder(logs)
    const names = await readdir(logs)
    const model = await readFile(join(logs, names.find(name => name.includes('-model-'))), 'utf8')
    const insight = await readFile(join(logs, names.find(name => name.includes('-insight-' + taskId + '-'))), 'utf8')
    const importLog = await readFile(directLog, 'utf8')
    expect(JSON.parse(model)).toMatchObject({ area: 'model', phase: 'testModel', recordedAt: expect.any(String) })
    expect(JSON.parse(insight)).toMatchObject({ taskId, phase: 'writing', code: 'INSIGHT_BUDGET_EXHAUSTED',
      analyzedMessages: 1, budget: { name: 'maxOutputTokens', limit: 32_768 } })
    expect(importLog).toContain('错误码=')
    expect(model + insight + importLog).not.toContain(privateMarker)
    await expect(page.getByText(previousDataLogs, { exact: false })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('storage-install-logs.png') })
    const archivedErrors = join(previousDataLogs, 'import-errors')
    await mkdir(archivedErrors)
    const legacyName = (await readdir(join(logs, 'import-errors'))).find(name => name.endsWith('-' + importJob + '.txt'))
    expect(legacyName).toBeTruthy()
    const legacyPath = join(logs, 'import-errors', legacyName)
    const legacyContents = await readFile(legacyPath, 'utf8')
    const archivedLog = join(archivedErrors, legacyName)
    await copyFile(legacyPath, archivedLog)
    await unlink(legacyPath)
    await unlink(directLog)
    await app.close(); app = undefined
    await access('Block')
    restoreAccess = true
    await launch()
    const startupWarning = page.getByRole('listitem').filter({ has: page.getByRole('alert', { name: '' }).filter({ hasText: '未能保存错误日志' }) })
    await expect(startupWarning).toBeVisible()
    await startupWarning.getByRole('button', { name: '展开详情' }).click()
    await expect(startupWarning.getByText(/无法写入安装日志目录/)).toContainText(logs)
    await startupWarning.getByRole('button', { name: '关闭提醒' }).click()
    await button('导入会话').click()
    await page.getByRole('region', { name: '导入失败' }).getByRole('button', { name: '查看错误日志' }).click()
    await expect.poll(lastOpen).toEqual({ path: archivedLog, result: '' })
    expect(await readFile(archivedLog, 'utf8')).toBe(legacyContents)
    await openStorage()
    await expect(writeFile(join(logs, 'blocked-probe.tmp'), '')).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) })
    await expect(page.evaluate(() => window.whomi.importDiagnostics.report({ phase: 'parse', code: 'INVALID_RECORD' }))).rejects.toThrow()
    await expect(page.evaluate(id => window.whomi.settings.testModel(id), modelId)).rejects.toThrow()
    const opens = () => app.evaluate(() => globalThis.logOpens.length)
    const before = await opens()
    await button('打开错误日志目录').click()
    await expect(page.getByText(/^无法写入安装日志目录 /).first()).toContainText(logs)
    expect(await opens()).toBe(before)
    expect((await readdir(previousDataLogs)).sort()).toEqual(['import-errors', 'older-model.json'])
    expect(await readdir(archivedErrors)).toEqual([legacyName])
    if (install !== profile) expect(await readdir(profile)).not.toContain('logs')
    await page.screenshot({ path: info.outputPath('storage-install-permission.png') })
    await access('Restore')
    restoreAccess = false
    await button('打开错误日志目录').click()
    await confirmFolder(logs)
    await expect(page.getByRole('status').filter({ hasText: /[1-9]\d* 条错误日志未保存/ })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(320, 320)
      window.setSize(400, 760)
    })
    const logButton = button('打开错误日志目录')
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(400)
    await logButton.scrollIntoViewIfNeeded()
    expect(await logButton.evaluate(node => {
      const bounds = node.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= window.innerWidth
    })).toBe(true)
    await page.screenshot({ path: info.outputPath('storage-install-narrow.png') })
    await page.evaluate(() => window.whomi.importDiagnostics.report({ phase: 'parse', code: 'INVALID_RECORD' }))
    expect(await readdir(join(logs, 'import-errors'))).toContainEqual(expect.stringMatching(/-none\.txt$/))
  } catch (error) {
    await page?.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    try { if (restoreAccess) await access('Restore') }
    finally {
      await app?.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    async function clean(path) {
      try { await rm(path, { recursive: true, force: true }) }
      catch (error) {
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
        console.info('Windows viewer is holding the synthetic test folder: ' + path)
      }
    }
    if (dirname(data) === dataRoot && basename(data).startsWith('feedback-')) await clean(data)
    if (install !== profile && !nativeFolderPending && dirname(install) === await realpath(tmpdir()) && basename(install).startsWith('whomi-test-log-install-')) await clean(install)
    if (!nativeFolderPending && dirname(profile) === await realpath(tmpdir()) && basename(profile).startsWith('whomi-runtime-error-logs-')) {
      await clean(profile)
    }
  }
})

test('startup reports where to find logs when the selected data disk is unavailable', async ({}, info) => {
  const electronExecutable = createRequire(import.meta.url)('electron')
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'whomi-runtime-startup-logs-')))
  const logs = join(profile, 'logs')
  try {
    let offline = join(profile, 'offline-drive')
    if (process.platform === 'win32') {
      for (const letter of 'DZYXWVUTSRQPONMLKJIHGFE') {
        const root = letter + ':\\'
        const absent = await fileAccess(root).then(() => false, error => error.code === 'ENOENT')
        if (absent) { offline = join(root, 'WhomiData'); break }
      }
    }
    await writeFile(info.outputPath('offline-location.txt'), offline)
    await writeFile(join(profile, 'storage-location.json'), JSON.stringify({ version: 1, path: offline, hasDatabase: true }))
    const launch = () => invoke(electronExecutable, [resolve('out/main/index.cjs'), '--whomi-runtime-test'], {
      env: { ...process.env, WHOMI_RUNTIME_TEST: profile }, windowsHide: true, timeout: 12_000,
    })
    const capture = async label => {
      const result = await launch().then(value => ({ ...value, code: 0 }), error => error)
      await writeFile(info.outputPath(label + '-stdout.log'), result.stdout ?? '')
      await writeFile(info.outputPath(label + '-stderr.log'), result.stderr ?? '')
      expect(result.code).toBe(1)
      return result.stderr
    }
    expect(await capture('startup-log')).toContain('Whomi test startup failed: STORAGE_UNAVAILABLE ' + logs)
    const entries = await readdir(logs)
    const entry = entries.find(name => name.includes('-startup-'))
    expect(JSON.parse(await readFile(join(logs, entry), 'utf8'))).toMatchObject({ area: 'startup', phase: 'initialize', code: 'STORAGE_UNAVAILABLE' })
    const folder = join(logs, 'operations')
    const files = await readdir(folder)
    expect(files).toHaveLength(1)
    const operation = await readFile(join(folder, files[0]), 'utf8')
    expect(operation).toContain('打开数据库')
    expect(operation).toContain('STORAGE_UNAVAILABLE')
    expect(operation).not.toContain(offline)
    await writeFile(info.outputPath('startup-operation.txt'), operation)
    await unlink(join(folder, files[0]))
    await rmdir(folder)
    await unlink(join(logs, entry))
    await rmdir(logs)
    await writeFile(logs, 'fixture blocks log directory creation')
    expect(await capture('log-directory-unavailable')).toContain('Whomi test startup failed: STORAGE_UNAVAILABLE ERROR_LOG_UNWRITABLE')
  } finally {
    if (dirname(profile) === await realpath(tmpdir()) && basename(profile).startsWith('whomi-runtime-startup-logs-')) {
      await rm(profile, { recursive: true, force: true })
    }
  }
})

test('data storage opens installation logs with the data service offline', async ({}, info) => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'whomi-runtime-offline-data-')))
  let app, page
  try {
    await writeFile(join(profile, 'probe.cjs'), 'module.exports = () => async () => true')
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: profile } })
    page = await app.firstWindow()
    const button = name => page.getByRole('button', { name, exact: true })
    await expect(button('设置')).toBeVisible()
    await app.evaluate(async ({ shell }) => {
      shell.openPath = async path => { globalThis.openedLogFolder = path; return '' }
      process.emit('uncaughtExceptionMonitor', new Error('PRIVATE_RUNTIME_FIXTURE'), 'uncaughtException')
      await globalThis.__whomiRuntimeProbe.close()
    })
    await button('设置').click()
    await button('数据存储').click()
    await expect(button('重新读取设置')).toBeVisible()
    await button('打开错误日志目录').click()
    await expect.poll(() => app.evaluate(() => globalThis.openedLogFolder)).toBe(join(profile, 'logs'))
    const names = await readdir(join(profile, 'logs'))
    expect(names.some(name => name.includes('-data-'))).toBe(true)
    const main = await readFile(join(profile, 'logs', names.find(name => name.includes('-main-'))), 'utf8')
    expect(JSON.parse(main)).toMatchObject({ area: 'main', phase: 'uncaughtException', code: 'MAIN_PROCESS_ERROR' })
    expect(main).not.toContain('PRIVATE_RUNTIME_FIXTURE')
    await expect(button('打开错误日志目录')).toBeEnabled()
    await page.screenshot({ path: info.outputPath('storage-without-data.png') })
  } catch (error) {
    await page?.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await app?.close()
    if (dirname(profile) === await realpath(tmpdir()) && basename(profile).startsWith('whomi-runtime-offline-data-')) await rm(profile, { recursive: true, force: true })
  }
})
