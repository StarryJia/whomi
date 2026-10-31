import { app, BrowserWindow, Menu, session, ipcMain, dialog, safeStorage, shell } from 'electron'
import { dirname, join } from 'node:path'
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
import { aiChannels, type AiMethods } from '../../src/shared/ai-contract'
import { createSettingsService } from './settings-service'
import { createStorageLocationService, resolveStorageLocation } from './storage-location'
import { settingsChannel, type SettingsApi, type SettingsSnapshot } from '../../src/shared/settings-contract'
import { settingsMethods } from '../../src/data/settings-client'
import type { ProcessingMember } from './message-processing'
import { loadWindowState, rememberWindowState } from './window-state'
import { version as appVersion } from '../../package.json'

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
    const userDataPath = app.getPath('userData')
    let suspended = false, servicesClosed = false, requests = 0
    let publishImport: Parameters<DataHost['onEvent']>[0] = () => {}
    let publishAi: Parameters<NonNullable<typeof aiService>['subscribe']>[0] = () => {}
    const secrets = createCredentialVault(safeStorage)
    async function startServices(directory: string) {
      dataHost = startDataHost(directory)
      if (probeEnabled) (globalThis as typeof globalThis & { __whomiRuntimeProbe?: DataHost }).__whomiRuntimeProbe = dataHost
      await dataHost.request('health', null)
      dataHost.onEvent(snapshot => publishImport(snapshot))
      agentHost = startAgentHost(directory)
      aiService = createAiService({ storage: (method, args) => dataHost!.request('aiStorage', [method, args]), runtime: agentHost, secrets,
        changed: event => publishAi(event),
        processing: async conversationId => {
          const [settings, members] = await Promise.all([dataHost!.request<SettingsSnapshot>('settingsStorage', ['get', []]), dataHost!.request<ProcessingMember[]>('listMembers', [conversationId])])
          return { settings: settings.processing, members }
        }, claimProcessing: (id, signature) => dataHost!.request('settingsStorage', ['claimProcessing', [id, signature]]) })
      servicesClosed = false
    }
    await startServices(await resolveStorageLocation(userDataPath))
    const aiRouter = createAiRouter(new Proxy({} as AiMethods, { get: (_target, method: keyof AiMethods) => (...args: unknown[]) => (aiService![method] as (...values: unknown[]) => Promise<unknown>)(...args) }))
    publishAi = event => aiRouter.publish(event)
    const locations = createStorageLocationService({ userDataPath, blockedDirectories: app.isPackaged ? [dirname(process.execPath)] : [],
      async stopServices() {
        suspended = true
        const state = await dataHost!.request<{ importActive: boolean }>('storageState', null)
        if (requests > 1 || state.importActive || aiService!.isBusy()) { suspended = false; throw new BoundaryError('STORAGE_BUSY', '请先完成或取消导入，并停止模型任务后重试。') }
        servicesClosed = true
        try { await aiService!.close() } finally { await Promise.allSettled([agentHost!.close(), dataHost!.close()]) }
      }, async resumeServices(directory) {
        if (servicesClosed) await startServices(directory)
        suspended = false
      } })
    const settingsService = createSettingsService({ storage: (method, args) => dataHost!.request('settingsStorage', [method, args]), secrets,
      testModel: id => aiService!.testModel(id), beforeModelChange: async ids => { if (aiService!.hasModelWork(ids)) throw new BoundaryError('MODEL_BUSY', '请先停止使用此模型的任务后重试。') } })
    const diagnostics: { code: string; action: string }[] = []
    const credential = randomUUID()
    Menu.setApplicationMenu(null)
    const state = loadWindowState(app.getPath('userData'))
    const window = new BrowserWindow({
      ...state.bounds, show: false, backgroundColor: '#f5f7f9', title: 'Whomi',
      icon: app.isPackaged ? join(process.resourcesPath, 'branding/icon.png') : join(app.getAppPath(), 'build/icon.png'),
      titleBarStyle: 'hidden',
      ...(process.platform === 'win32' ? { titleBarOverlay: { color: '#f5f7f9', symbolColor: '#5c6674', height: 36 } } : {}),
      webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--whomi-drop-key=${credential}`] },
    })
    rememberWindowState(window, app.getPath('userData'))
    window.once('ready-to-show', () => { if (state.maximized) window.maximize(); window.show() })
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const pagePath = join(__dirname, '../renderer/index.html')
    const appUrl = devUrl ? new URL(devUrl).href : pathToFileURL(pagePath).href
    const windowId = window.webContents.id
    const grants = createSourceGrants()
    const router = createDesktopRouter({ grants, request: (method, args) => method === 'deleteConversation'
      ? aiService!.deleteConversation((args as [string])[0], async () => { await dataHost!.request(method, args) })
      : dataHost!.request(method, args), async chooseSources(_owner, kind) {
      const result = await dialog.showOpenDialog(window, { properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory'] })
      return result.canceled || !result.filePaths.length ? [] : grants.issue(window.webContents.id, result.filePaths)
    } })
    publishImport = snapshot => router.publish(snapshot)
    const stopWindowEvents = router.onImport(window.webContents.id, snapshot => { if (!window.isDestroyed()) window.webContents.send(desktopChannels.progress, snapshot) })
    const stopAiWindow = aiRouter.subscribe(windowId, event => { if (!window.isDestroyed()) window.webContents.send(aiChannels.event, event) })
    ipcMain.handle(aiChannels.call, async (event, value: unknown) => {
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (suspended) throw new BoundaryError('STORAGE_RESTART_REQUIRED', '数据目录正在切换，请重启应用。')
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'method') || !Object.hasOwn(value, 'args')) throw new BoundaryError('INVALID_ARGUMENT')
        const request = value as { method: unknown; args: unknown }
        requests++
        try { return { ok: true, value: await aiRouter.invoke(windowId, request.method, request.args) } } finally { requests-- }
      } catch (error) { return { ok: false, error: serializableError(error) } }
    })
    const settingsApi: SettingsApi = { ...settingsService,
      async stopModelTasks(ids) { if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || id.length > 128)) throw new BoundaryError('INVALID_ARGUMENT'); await aiService!.stopModelTasks(ids) },
      getStorage: () => locations.getStorage(),
      async chooseStorage() { const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }); return selected.canceled || !selected.filePaths[0] ? null : locations.issueChoice(windowId, selected.filePaths[0]) },
      relocateStorage: token => locations.relocateStorage(windowId, token),
      async restart() { if (!suspended || !(await locations.getStorage()).restartRequired) throw new BoundaryError('INVALID_STATE'); app.relaunch(); app.quit() },
      async getDiagnostics() { const current = await settingsService.get(); return { version: appVersion, platform: process.platform, entries: current.debug ? [...diagnostics] : [] } },
    }
    ipcMain.handle(settingsChannel, async (event, value: unknown) => {
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !('method' in value) || !('args' in value) || typeof value.method !== 'string' || !Object.hasOwn(settingsMethods, value.method) || !Array.isArray(value.args)) throw new BoundaryError('INVALID_ARGUMENT')
        const method = value.method as keyof SettingsApi
        if (value.args.length !== settingsMethods[method]) throw new BoundaryError('INVALID_ARGUMENT')
        if (suspended && !['getStorage', 'restart'].includes(method)) throw new BoundaryError('STORAGE_RESTART_REQUIRED', '数据目录正在切换，请重启应用。')
        requests++
        try { return { ok: true, value: await (settingsApi[method] as (...args: unknown[]) => Promise<unknown>)(...value.args) } } finally { requests-- }
      } catch (error) {
        const failure = serializableError(error)
        diagnostics.push({ code: failure.code, action: '操作失败，请重试。' }); if (diagnostics.length > 20) diagnostics.shift()
        return { ok: false, error: failure }
      }
    })
    async function handle(event: Electron.IpcMainInvokeEvent, value: unknown, dropped = false) {
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (suspended) throw new BoundaryError('STORAGE_RESTART_REQUIRED', '数据目录正在切换，请重启应用。')
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoundaryError('INVALID_ARGUMENT')
        const request = value as Record<string, unknown>
        let result: unknown
        if (dropped) {
          if (Object.keys(request).length !== 2 || request.credential !== credential || !Array.isArray(request.paths) || !request.paths.every(path => typeof path === 'string')) throw new BoundaryError('INVALID_SOURCE', '请重新拖入文件或文件夹。')
          result = await grants.issue(window.webContents.id, request.paths as string[])
        } else {
          if (Object.keys(request).length !== 2 || !Object.hasOwn(request, 'method') || !Object.hasOwn(request, 'args')) throw new BoundaryError('INVALID_ARGUMENT')
          requests++
          try { result = await router.invoke(window.webContents.id, request.method, request.args) } finally { requests-- }
        }
        return { ok: true, value: result }
      } catch (error) { return { ok: false, error: serializableError(error) } }
    }
    ipcMain.handle(desktopChannels.call, (event, value) => handle(event, value))
    ipcMain.handle(desktopChannels.drop, (event, value) => handle(event, value, true))
    window.once('closed', () => { locations.revokeOwner(windowId); stopWindowEvents(); stopAiWindow(); aiRouter.release(windowId); router.releaseWindow(windowId); ipcMain.removeHandler(settingsChannel); ipcMain.removeHandler(aiChannels.call); ipcMain.removeHandler(desktopChannels.call); ipcMain.removeHandler(desktopChannels.drop) })
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const link = new URL(url)
        if (['https:', 'http:'].includes(link.protocol) && link.hostname && !link.username && !link.password && url.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(url)) {
          void shell.openExternal(link.href).catch(() => { if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', message: '无法打开链接。', detail: '请将链接复制到浏览器中打开。' }) })
        }
      } catch { /* 非网页地址不能交给系统执行。 */ }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    const ownDocument = (url?: string) => !!url && url.split('#')[0] === appUrl.split('#')[0]
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
      contents === window.webContents && details.isMainFrame && permission === 'clipboard-sanitized-write' && ownDocument(details.requestingUrl),
    ))
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window.webContents && details.isMainFrame && permission === 'clipboard-sanitized-write' && ownDocument(details.requestingUrl))
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [devUrl ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'"],
    } }))
    if (devUrl) await window.loadURL(devUrl)
    else await window.loadFile(pagePath)
  }).catch(async error => {
    if (quitting) return
    const detail = error instanceof BoundaryError && error.code.startsWith('STORAGE_')
      ? `${error.message}\n连接保存会话的磁盘或恢复原保存目录后，重新打开 Whomi。`
      : '无法打开本地数据。请检查保存目录是否可访问，然后重新打开 Whomi。'
    if (probeEnabled) console.error('Whomi test startup failed:', serializableError(error).code)
    else dialog.showErrorBox('Whomi 无法启动', detail)
    await Promise.allSettled([agentHost?.close(), dataHost?.close()])
    app.exit(1)
  })
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
