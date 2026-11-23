import { expect, test, _electron as electron } from '@playwright/test'
import { basename, dirname, join, resolve } from 'node:path'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

test('migration keeps the original operation through the first successful database reopen', async ({}, info) => {
  const root = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(root, 'whomi-runtime-operation-')))
  const target = await realpath(await mkdtemp(join(root, 'whomi-migrated-operation-')))
  const logs = join(directory, 'logs', 'operations')
  let app
  const launch = () => electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
  try {
    await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => () => null')
    app = await launch()
    const first = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, target)
    const location = await first.evaluate(async () => {
      const settings = window.whomi.settings
      const choice = await settings.chooseStorage()
      return settings.relocateStorage(choice.token)
    })
    expect(location.path).toBe(target)
    const migrations = async () => (await readdir(logs)).filter(name => name.includes('-数据存储-'))
    await expect.poll(migrations).toHaveLength(1)
    const [filename] = await migrations()
    const contents = () => readFile(join(logs, filename), 'utf8')
    await expect.poll(contents).toContain('等待重启')
    await app.close()
    app = await launch()
    const second = await app.firstWindow()
    expect((await second.evaluate(() => window.whomi.settings.getStorage())).path).toBe(target)
    await expect.poll(contents).toContain('结果：成功')
    const text = await contents()
    expect(text).toContain('记录：完整')
    expect(text).toContain('阶段=重新打开')
    expect(text).toMatch(/文件数=[1-9]/)
    expect(text).not.toContain(target)
    expect(await migrations()).toEqual([filename])
    await info.attach('migration-reopen.txt', { body: text, contentType: 'text/plain' })
  } finally {
    await app?.close()
    if (dirname(directory) === root && basename(directory).startsWith('whomi-runtime-operation-')) await rm(directory, { recursive: true, force: true })
    if (dirname(target) === root && basename(target).startsWith('whomi-migrated-operation-')) await rm(target, { recursive: true, force: true })
  }
})

test('files selected from a failed import and from storage are standalone issue attachments', async ({}, info) => {
  test.setTimeout(90_000)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'whomi-runtime-operation-')))
  let app, page
  const privateText = 'PRIVATE_ATTACHMENT_SENTINEL'
  try {
    const good = join(directory, 'private-file.json'), folder = join(directory, 'private-folder')
    await mkdir(folder)
    await copyFile('tests/fixtures/import/chatlab/positive.json', good)
    await writeFile(join(folder, 'a.txt'), privateText)
    await writeFile(join(folder, 'b.txt'), privateText)
    await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => () => null')
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    const button = name => page.getByRole('button', { name, exact: true })
    await app.evaluate(({ shell, dialog, ipcMain }, paths) => {
      globalThis.operationOpened = []
      globalThis.operationLinks = []
      shell.openPath = async path => { globalThis.operationOpened.push(path); return '' }
      shell.openExternal = async url => { globalThis.operationLinks.push(url) }
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift()] })
      const original = ipcMain._invokeHandlers.get('whomi:call')
      ipcMain.removeHandler('whomi:call')
      ipcMain.handle('whomi:call', async (event, request) => {
        const response = await original(event, request)
        if (request.method === 'prepareImport' && response.ok) {
          await new Promise(done => { globalThis.releaseOperationReply = done })
          delete globalThis.releaseOperationReply
        }
        return response
      })
    }, [good, folder])
    const logFolder = join(directory, 'logs', 'operations')
    const importFiles = async () => (await readdir(logFolder)).filter(name => name.includes('-导入-') && name.endsWith('.txt'))
    async function choose(label, count) {
      await button(label).click()
      await expect.poll(() => app.evaluate(() => !!globalThis.releaseOperationReply)).toBe(true)
      await expect.poll(importFiles).toHaveLength(count)
      expect(await page.evaluate(() => localStorage.getItem('whomi:import-job'))).toBe(null)
      if (count === 1) {
        const modelId = await page.evaluate(async () => {
          const provider = await window.whomi.settings.saveProvider({ name: '合成服务', baseUrl: 'http://127.0.0.1:1/v1', enabled: true })
          const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '合成模型', model: 'test-model', enabled: false, contextWindow: 16000, maxTokens: 1000 })
          return model.id
        })
        await expect(page.evaluate(id => window.whomi.settings.testModel(id), modelId)).rejects.toThrow()
        await expect.poll(async () => (await readdir(logFolder)).filter(name => name.includes('-模型-'))).toHaveLength(1)
      }
      await app.evaluate(() => globalThis.releaseOperationReply())
    }
    await button('导入会话').click()
    await choose('选择文件', 1)
    await expect(page.getByText('导入完成', { exact: true })).toBeVisible()
    const [savedName] = await importFiles()
    const savedPath = join(logFolder, savedName)
    const savedText = () => readFile(savedPath, 'utf8')
    await expect.poll(savedText).toContain('结果：成功')
    const saved = await savedText()
    expect(saved).toContain('文件数=1')
    expect(saved).toContain('新增消息数=2')
    expect(saved).toContain('阶段=刷新')
    await button('继续导入').click()
    await choose('选择文件夹', 2)
    const failure = page.getByRole('region', { name: '导入失败' })
    await expect(failure.getByRole('button')).toHaveCount(2)
    await button('查看错误日志').click()
    const opens = () => app.evaluate(() => globalThis.operationOpened)
    await expect.poll(opens).toHaveLength(1)
    const [failurePath] = await opens()
    expect(dirname(failurePath)).toBe(logFolder)
    expect(failurePath).not.toBe(savedPath)
    const failed = await readFile(failurePath, 'utf8')
    expect(failed).toContain('结果：失败')
    expect(failed).toContain('所选来源数=1')
    expect(failed).toContain('文件数=2')
    expect(failed).toContain('NO_IMPORTABLE_CONVERSATIONS')
    expect(failed).not.toContain(saved.match(/操作编号：([^\n]+)/)[1])
    const modelName = (await readdir(logFolder)).find(name => name.includes('-模型-'))
    const model = await readFile(join(logFolder, modelName), 'utf8')
    expect(model).toContain('结果：失败')
    const modelId = model.match(/操作编号：([^\n]+)/)[1]
    expect(saved).not.toContain(modelId)
    expect(failed).not.toContain(modelId)
    expect(failed).not.toContain(privateText)
    expect(failed).not.toContain(directory)
    await page.screenshot({ path: info.outputPath('failure-operation.png') })
    await button('设置').click()
    await button('数据存储').click()
    await button('打开错误日志目录').click()
    await expect.poll(opens).toEqual([failurePath, dirname(logFolder)])
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(320, 320)
      win.setSize(400, 760)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(400)
    await page.getByRole('link', { name: '创建问题工单' }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('storage-issue-link-narrow.png') })
    await page.locator('.settings-log-action').screenshot({ path: info.outputPath('storage-log-actions.png') })
    await page.getByRole('link', { name: '创建问题工单' }).click()
    await expect.poll(() => app.evaluate(() => globalThis.operationLinks)).toEqual(['https://github.com/StarryJia/whomi/issues/new?template=bug_report.md'])
    // 本地附件控件验证选择的原文件，不向 GitHub 发送内容。
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'local-attachment'; document.body.append(input) })
    const input = page.locator('#local-attachment')
    for (const [path, expected] of [[savedPath, saved], [failurePath, failed]]) {
      await input.setInputFiles(path)
      expect(await input.evaluate(async el => (await el.files[0].text()))).toBe(expected)
      await info.attach(basename(path), { path, contentType: 'text/plain' })
    }
  } catch (error) {
    await page?.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await app?.close()
    if (dirname(directory) === await realpath(tmpdir()) && basename(directory).startsWith('whomi-runtime-operation-')) await rm(directory, { recursive: true, force: true })
  }
})
