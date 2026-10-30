import { app, BrowserWindow, session, ipcMain, dialog, safeStorage } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { validateRuntimeTestDirectory } from '../runtime-test-directory'
import { startDataHost } from './data-host'
import type { DataHost } from './data-host'
import { createSourceGrants } from './source-grants'
import { createDesktopRouter, desktopChannels, isTrustedCaller, serializableError } from './ipc'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { startAgentHost, type AgentHost } from './ai-host'
import { createAiService } from './ai-service'
import { createAiRouter } from './ai-router'
import { createCredentialVault } from './ai-credentials'
import { aiChannels } from '../../src/shared/ai-contract'

// 测试资料必须是操作系统临时目录下的独立目录。
let testDirectory: string | undefined
if (process.argv.includes('--whomi-runtime-test')) {
  try { testDirectory = validateRuntimeTestDirectory(process.env.WHOMI_RUNTIME_TEST) }
  catch { app.exit(1) }
}
const probeEnabled = Boolean(testDirectory)
if (testDirectory) {
  process.env.WHOMI_RUNTIME_TEST = testDirectory
  app.setPath('userData', testDirectory)
}
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Whomi Development'))
let dataHost: DataHost | undefined
let agentHost: AgentHost | undefined
let aiService: ReturnType<typeof createAiService> | undefined
let quitting = false
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    dataHost = startDataHost(app.getPath('userData'))
    if (probeEnabled) (globalThis as typeof globalThis & { __whomiRuntimeProbe?: DataHost }).__whomiRuntimeProbe = dataHost
    await dataHost.request('health', null)
    agentHost = startAgentHost(app.getPath('userData'))
    aiService = createAiService({ storage: (method, args) => dataHost!.request('aiStorage', [method, args]), runtime: agentHost, secrets: createCredentialVault(safeStorage) })
    const aiRouter = createAiRouter(aiService)
    const credential = randomUUID()
    const window = new BrowserWindow({ webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--whomi-drop-key=${credential}`] } })
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const pagePath = join(__dirname, '../renderer/index.html')
    const appUrl = devUrl ? new URL(devUrl).href : pathToFileURL(pagePath).href
    const windowId = window.webContents.id
    const grants = createSourceGrants()
    const router = createDesktopRouter({ grants, request: (method, args) => dataHost!.request(method, args), async chooseSources(_owner, kind) {
      const result = await dialog.showOpenDialog(window, { properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory'] })
      return result.canceled || !result.filePaths.length ? [] : grants.issue(window.webContents.id, result.filePaths)
    } })
    const stopEvents = dataHost.onEvent(snapshot => router.publish(snapshot))
    const stopWindowEvents = router.onImport(window.webContents.id, snapshot => { if (!window.isDestroyed()) window.webContents.send(desktopChannels.progress, snapshot) })
    const stopAiEvents = aiService.subscribe(event => aiRouter.publish(event))
    const stopAiWindow = aiRouter.subscribe(windowId, event => { if (!window.isDestroyed()) window.webContents.send(aiChannels.event, event) })
    ipcMain.handle(aiChannels.call, async (event, value: unknown) => {
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'method') || !Object.hasOwn(value, 'args')) throw new BoundaryError('INVALID_ARGUMENT')
        const request = value as { method: unknown; args: unknown }
        return { ok: true, value: await aiRouter.invoke(windowId, request.method, request.args) }
      } catch (error) { return { ok: false, error: serializableError(error) } }
    })
    async function handle(event: Electron.IpcMainInvokeEvent, value: unknown, dropped = false) {
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoundaryError('INVALID_ARGUMENT')
        const request = value as Record<string, unknown>
        let result: unknown
        if (dropped) {
          if (Object.keys(request).length !== 2 || request.credential !== credential || !Array.isArray(request.paths) || !request.paths.every(path => typeof path === 'string')) throw new BoundaryError('INVALID_SOURCE', '请重新拖入文件或文件夹。')
          result = await grants.issue(window.webContents.id, request.paths as string[])
        } else {
          if (Object.keys(request).length !== 2 || !Object.hasOwn(request, 'method') || !Object.hasOwn(request, 'args')) throw new BoundaryError('INVALID_ARGUMENT')
          result = await router.invoke(window.webContents.id, request.method, request.args)
        }
        return { ok: true, value: result }
      } catch (error) { return { ok: false, error: serializableError(error) } }
    }
    ipcMain.handle(desktopChannels.call, (event, value) => handle(event, value))
    ipcMain.handle(desktopChannels.drop, (event, value) => handle(event, value, true))
    window.once('closed', () => { stopEvents(); stopWindowEvents(); stopAiEvents(); stopAiWindow(); aiRouter.release(windowId); router.releaseWindow(windowId); ipcMain.removeHandler(aiChannels.call); ipcMain.removeHandler(desktopChannels.call); ipcMain.removeHandler(desktopChannels.drop) })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [devUrl ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'"],
    } }))
    if (devUrl) await window.loadURL(devUrl)
    else await window.loadFile(pagePath)
  }).catch(() => { app.exit(1) })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (!quitting && dataHost) {
      event.preventDefault()
      quitting = true
      void (async () => {
        try { await aiService?.close() } catch { /* 数据进程退出时仍需回收Agent进程。 */ }
        await Promise.allSettled([agentHost?.close(), dataHost!.close()])
      })().finally(() => app.quit())
    }
  })
}
