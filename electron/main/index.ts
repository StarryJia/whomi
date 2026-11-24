import { subscriptionHeaders } from './cherry-accounts-runner'
import { createInsightSessionCleanup } from './insight-session-cleanup'
import { app, BrowserWindow, Menu, session, ipcMain, dialog, safeStorage, shell } from 'electron'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { validateRuntimeTestDirectory } from '../runtime-test-directory'
import { startDataHost } from './data-host'
import type { DataHost } from './data-host'
import { createSourceGrants } from './source-grants'
import { createDesktopRouter, desktopChannels, isTrustedCaller, serializableError } from './ipc'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import { isOperationId } from '../../src/shared/operation-diagnostics'
import { startAgentHost, type AgentHost } from './ai-host'
import { createAiService } from './ai-service'
import { createAiRouter } from './ai-router'
import { createCredentialVault } from './ai-credentials'
import { aiChannels, type AiMethods } from '../../src/shared/ai-contract'
import { createCherryAccount } from './cherry-accounts'
import { subscriptionProviders, type SubscriptionProviderId } from '../../src/shared/chatgpt-plan'
import { createChatgptAuth } from './chatgpt-auth'
import { createCodexQuota } from './codex-quota'
import { createChatgptRunner } from './chatgpt-responses'
import { createSettingsService } from './settings-service'
import { createStorageLocationService, resolveStorageSelection } from './storage-location'
import { settingsChannel, type SettingsApi, type SettingsSnapshot } from '../../src/shared/settings-contract'
import { settingsMethods } from '../../src/data/settings-client'
import type { ProcessingMember } from './message-processing'
import { loadWindowState, rememberWindowState } from './window-state'
import { createImportDiagnostics, snapshotDiagnostic } from './import-diagnostics'
import { createAppErrorLogs } from './app-error-logs'
import { createOperationDiagnostics } from './operation-diagnostics'
import { createConversationRecorder, recordSetting } from './lifecycle-diagnostics'
import { createImportOperationTracker } from './import-operation-tracker'
import { operationDiagnosticsChannel } from '../../src/shared/operation-diagnostics-api'
import { appExceptionChannel, importDiagnosticsChannel, type StoredImportDiagnostic } from '../../src/shared/import-diagnostics'
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
  const installDirectory = app.isPackaged ? dirname(process.execPath) : testDirectory ?? app.getAppPath()
  const appErrorLogs = createAppErrorLogs(installDirectory, app.getPath('userData'), appVersion, path => shell.openPath(path))
  const operations = createOperationDiagnostics(installDirectory, appVersion, { onWriteFailure: () => appErrorLogs.recordWriteFailure() })
  appErrorLogs.setOperationDiagnostics(operations)
  const startup = operations.begin('startup', 'launch')
  operations.event(startup, 'startup')
  let previousMigration: string | undefined
  async function finishReopen(success: boolean, code?: string) {
    if (!previousMigration) return
    const id = previousMigration
    previousMigration = undefined
    const previous = (await operations.list()).find(entry => entry.id === id && entry.area === 'storage' && entry.action === 'migrate')
    if (previous && (previous.outcome === 'interrupted' || previous.outcome === 'running')) {
      operations.resume(id)
      operations.event(id, 'reopen')
      operations.end(id, success ? 'success' : 'failed', { code })
    }
  }
  process.on('uncaughtExceptionMonitor', (_error, origin) => appErrorLogs.recordMainException(origin))
  let stoppingWorkers = false
  app.on('child-process-gone', (_event, details) => {
    if (quitting || details.reason === 'clean-exit') return
    const area = details.name === 'Whomi Data' ? 'data' : details.name === 'Whomi Agent' ? 'model' : 'main'
    if (stoppingWorkers && details.reason === 'killed' && area !== 'main') return
    const code = area === 'data' ? 'DATA_PROCESS_GONE' : area === 'model' ? 'AGENT_UNAVAILABLE' : 'MAIN_PROCESS_ERROR'
    const id = operations.begin('startup', 'workerExit')
    operations.event(id, 'workerExit', { code })
    operations.end(id, 'failed', { code })
    void appErrorLogs.record({ area, phase: 'child-process-exit', error: new BoundaryError(code) })
  })
  app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    const userDataPath = app.getPath('userData')
    const requestData: DataHost['request'] = async <T>(method: string, args: unknown) => {
      try { return await dataHost!.request<T>(method, args) }
      catch (error) { void appErrorLogs.record({ area: 'data', phase: method, error }); throw error }
    }
    const importDiagnostics = createImportDiagnostics(userDataPath, appVersion, path => operations.openLegacyFile(path, file => shell.openPath(file)),
      jobId => requestData('getImport', [jobId]), appErrorLogs, {
        find: jobId => dataHost!.request('getImportDiagnosticFailure', jobId),
        acknowledge: receipt => dataHost!.request('acknowledgeImportDiagnostic', receipt),
      })
    let suspended = false, servicesClosed = false, requests = 0
    let publishImport: Parameters<DataHost['onEvent']>[0] = () => {}
    let publishAi: Parameters<NonNullable<typeof aiService>['subscribe']>[0] = () => {}
    const secrets = createCredentialVault(safeStorage)
    const accountOptions = { directory: userDataPath, vault: secrets, openBrowser: (url: string) => shell.openExternal(url) }
    const chatgpt = createChatgptAuth(accountOptions)
    const codexQuota = createCodexQuota({ directory: userDataPath, vault: secrets })
    const grok = createCherryAccount('grok-cli', { ...accountOptions, clientId: process.env.WHOMI_GROK_CLIENT_ID })
    const copilot = createCherryAccount('copilot', { ...accountOptions, clientId: process.env.WHOMI_COPILOT_CLIENT_ID })
    const accounts = { 'openai-codex': chatgpt, 'grok-cli': grok, copilot }
    const accountRunners = { 'openai-codex': createChatgptRunner((id, signal) => chatgpt.accessToken(id, signal)), 'grok-cli': grok.runner, copilot: copilot.runner }
    app.once('before-quit', () => { codexQuota.close(); for (const account of Object.values(accounts)) account.close() })
    async function startServices(directory: string, operationId?: string) {
      dataHost = startDataHost(directory, (fromVersion, toVersion) => {
        if (operationId) operations.event(operationId, 'databaseUpgrade', { fromVersion, toVersion })
      })
      if (probeEnabled) (globalThis as typeof globalThis & { __whomiRuntimeProbe?: DataHost }).__whomiRuntimeProbe = dataHost
      const failures = await requestData<StoredImportDiagnostic[]>('unresolvedImportDiagnostics', null)
      for (const { diagnostic, counts, jobCreatedAt } of failures) void importDiagnostics.report(diagnostic, counts, jobCreatedAt).catch(() => {})
      dataHost.onEvent(snapshot => publishImport(snapshot))
      const insightSessions = createInsightSessionCleanup(directory, async id => {
        try { await dataHost!.request('aiStorage', ['getAnalysis', [id]]); return true }
        catch (error) {
          if (error instanceof BoundaryError && error.code === 'INVALID_TASK') return false
          throw error
        }
      })
      await insightSessions.recover().catch(error => appErrorLogs.record({ area: 'data', phase: 'insight-cleanup', error }))
      agentHost = startAgentHost(directory)
      aiService = createAiService({ storage: (method, args) => requestData('aiStorage', [method, args]), runtime: { run: async (input, options) => {
          if (!input.model.planAccount) return agentHost!.run(input, options)
          const provider: SubscriptionProviderId = input.model.planProvider ?? 'openai-codex'
          if (input.insightSession) {
            const authorized = subscriptionProviders[provider]
            if (!authorized || input.model.baseUrl !== authorized.baseUrl || input.model.protocol !== authorized.protocol) {
              throw new BoundaryError('INVALID_MODEL', '请重新选择此账户的模型。')
            }
            const headers = provider === 'openai-codex' ? undefined : subscriptionHeaders(provider, input.model.model)
            return agentHost!.run({ ...input, insightSession: { ...input.insightSession, headers } }, options)
          }
          return accountRunners[provider].run(input, options)
        } }, secrets, diagnostics: operations, deleteInsightSessions: insightSessions.remove,
        insightAccountAccess: async (model, accountId, signal) => {
          const provider = model.planProvider ?? 'openai-codex'
          return provider === 'openai-codex'
            ? { token: await chatgpt.accessToken(accountId, signal), baseUrl: subscriptionProviders[provider].baseUrl }
            : accounts[provider].access(accountId, signal)
        },
        changed: event => publishAi(event),
        logError: appErrorLogs.record,
        processing: async conversationId => {
          const [settings, members] = await Promise.all([requestData<SettingsSnapshot>('settingsStorage', ['get', []]), requestData<ProcessingMember[]>('listMembers', [conversationId])])
          return { settings: settings.processing, members }
        }, claimProcessing: (id, signature) => requestData('settingsStorage', ['claimProcessing', [id, signature]]) })
      servicesClosed = false
    }
    operations.event(startup, 'databaseOpen')
    const storage = await resolveStorageSelection(userDataPath, id => { previousMigration = id })
    appErrorLogs.setDataArchives(storage.path, storage.retainedErrorLogDirectories)
    await startServices(storage.path, startup)
    await finishReopen(true).catch(() => {})
    await importDiagnostics.flush()
    const aiRouter = createAiRouter(new Proxy({} as AiMethods, { get: (_target, method: keyof AiMethods) => (...args: unknown[]) => (aiService![method] as (...values: unknown[]) => Promise<unknown>)(...args) }))
    publishAi = event => aiRouter.publish(event)
    const locations = createStorageLocationService({ userDataPath, blockedDirectories: app.isPackaged ? [dirname(process.execPath)] : [],
      async stopServices() {
        suspended = true
        const state = await requestData<{ importActive: boolean }>('storageState', null)
        if (requests > 1 || state.importActive || aiService!.isBusy()) { suspended = false; throw new BoundaryError('STORAGE_BUSY', '请先完成或取消导入，并停止模型任务后重试。') }
        servicesClosed = true
        stoppingWorkers = true
        try { await aiService!.close() }
        finally {
          await Promise.allSettled([agentHost!.close(), dataHost!.close()])
          stoppingWorkers = false
        }
      }, async resumeServices(directory) {
        if (servicesClosed) await startServices(directory)
        suspended = false
      } })
    const settingsService = createSettingsService({ accounts, codexQuota, storage: (method, args) => requestData('settingsStorage', [method, args]), secrets,
      testModel: id => aiService!.testModel(id), beforeModelChange: async ids => { if (aiService!.hasModelWork(ids)) throw new BoundaryError('MODEL_BUSY', '请先停止使用此模型的任务后重试。') } })
    const diagnostics: { code: string; action: string }[] = []
    const credential = randomUUID()
    Menu.setApplicationMenu(null)
    const state = loadWindowState(app.getPath('userData'))
    const window = new BrowserWindow({
      ...state.bounds, show: false, backgroundColor: '#f5f7f9', title: 'Whomi',
      icon: app.isPackaged ? join(process.resourcesPath, 'branding/icon.png') : join(app.getAppPath(), 'build/icon.png'),
      titleBarStyle: 'hidden',
      // 透明底色让窗口按钮区随页面遮罩一起变暗。
      ...(process.platform === 'win32' ? { titleBarOverlay: { color: '#00000000', symbolColor: '#5c6674', height: 36 } } : {}),
      webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--whomi-drop-key=${credential}`] },
    })
    rememberWindowState(window, app.getPath('userData'))
    const rendererFailure = (phase: string, code: string) => { void appErrorLogs.record({ area: 'renderer', phase, error: new BoundaryError(code) }) }
    window.webContents.on('preload-error', () => rendererFailure('preload', 'PRELOAD_ERROR'))
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!quitting && details.reason !== 'clean-exit') rendererFailure('process-exit', 'RENDERER_PROCESS_GONE')
    })
    window.webContents.on('did-fail-load', (_event, code, _reason, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) rendererFailure('load', 'RENDERER_LOAD_FAILED')
    })
    let lastRendererError = 0
    window.webContents.on('console-message', ({ level }) => {
      const now = Date.now()
      if (level !== 'error' || now - lastRendererError < 5_000) return
      lastRendererError = now
      rendererFailure('console', 'RENDERER_ERROR')
    })
    window.once('ready-to-show', () => { if (state.maximized) window.maximize(); window.show() })
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const pagePath = join(__dirname, '../renderer/index.html')
    const appUrl = devUrl ? new URL(devUrl).href : pathToFileURL(pagePath).href
    const reportLogFailure = (action: string) => {
      if (!quitting && !window.isDestroyed()) window.webContents.send(appExceptionChannel, { title: '未能保存错误日志', detail: action })
    }
    const onExceptionListenerReady = (event: Electron.IpcMainEvent) => {
      if (!window.isDestroyed() && isTrustedCaller(event, window, appUrl)) appErrorLogs.setWriteFailureListener(reportLogFailure)
    }
    ipcMain.on(appExceptionChannel, onExceptionListenerReady)
    window.webContents.on('did-navigate', () => appErrorLogs.setWriteFailureListener(undefined))
    window.once('closed', () => {
      ipcMain.removeListener(appExceptionChannel, onExceptionListenerReady)
      appErrorLogs.setWriteFailureListener(undefined)
    })
    const windowId = window.webContents.id
    const grants = createSourceGrants()
    const imports = createImportOperationTracker(operations)
    const router = createDesktopRouter({ grants, imports, request: (method, args) => method === 'deleteConversation'
      ? aiService!.deleteConversation((args as [string])[0], async () => { await requestData(method, args) })
      : requestData(method, args), async chooseSources(_owner, kind) {
      const result = await dialog.showOpenDialog({ properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory'] })
        .catch(() => { throw new BoundaryError('PICKER_FAILED', '无法打开来源选择窗口。') })
      return result.canceled || !result.filePaths.length ? [] : grants.issue(window.webContents.id, result.filePaths, 'picker')
    } })
    publishImport = snapshot => {
      const diagnostic = snapshotDiagnostic(snapshot)
      if (diagnostic) void importDiagnostics.report(diagnostic, snapshot.counts, snapshot.jobCreatedAt).catch(() => {})
      router.publish(snapshot)
    }
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
      openStorageDirectory: () => locations.openDirectory(path => shell.openPath(path)),
      async chooseStorage() {
        const { path } = await locations.getStorage()
        const selected = await dialog.showOpenDialog(window, { defaultPath: path, properties: ['openDirectory', 'createDirectory'] })
        return selected.canceled || !selected.filePaths[0] ? null : locations.issueChoice(windowId, selected.filePaths[0])
      },
      async relocateStorage(token) {
        const id = operations.begin('storage', 'migrate')
        try {
          const location = await locations.relocateStorage(windowId, token, {
            id, stage: (name, counts) => operations.event(id, name, { ...counts, sourceLocation: 'original', targetLocation: 'new' }),
          })
          appErrorLogs.setDataArchives(location.path, location.retainedErrorLogDirectories)
          operations.event(id, 'waitingForRestart')
          return location
        } catch (error) {
          operations.end(id, 'failed', { code: serializableError(error).code })
          throw error
        }
      },
      async restart() { if (!suspended || !(await locations.getStorage()).restartRequired) throw new BoundaryError('INVALID_STATE'); app.relaunch(); app.quit() },
      async getDiagnostics() { const current = await settingsService.get(); return { version: appVersion, platform: process.platform, entries: current.debug ? [...diagnostics] : [] } },
      openErrorLogDirectory: appErrorLogs.open,
    }
    ipcMain.handle(settingsChannel, async (event, value: unknown) => {
      let method: keyof SettingsApi | undefined
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !('method' in value) || !('args' in value) || typeof value.method !== 'string' || !Object.hasOwn(settingsMethods, value.method) || !Array.isArray(value.args)) throw new BoundaryError('INVALID_ARGUMENT')
        method = value.method as keyof SettingsApi
        if (value.args.length !== settingsMethods[method]) throw new BoundaryError('INVALID_ARGUMENT')
        if (suspended && !['getStorage', 'openStorageDirectory', 'openErrorLogDirectory', 'restart'].includes(method)) throw new BoundaryError('STORAGE_RESTART_REQUIRED', '数据目录正在切换，请重启应用。')
        requests++
        const apply = settingsApi[method] as (...args: unknown[]) => Promise<unknown>
        const args = value.args
        try { return { ok: true, value: await recordSetting(operations, method, () => apply(...args)) } } finally { requests-- }
      } catch (error) {
        const failure = serializableError(error)
        if (method && method !== 'testModel' && method !== 'openErrorLogDirectory') {
          void appErrorLogs.record({ area: method === 'syncModels' || method === 'signInAccount' ? 'model' : 'main', phase: method, error })
        }
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
    const conversations = createConversationRecorder(operations)
    const receiveConversation = (event: Electron.IpcMainEvent, value: unknown) => {
      if (!window.isDestroyed() && isTrustedCaller(event, window, appUrl)) conversations.receive(value)
    }
    ipcMain.on(operationDiagnosticsChannel, receiveConversation)
    window.webContents.on('did-navigate', () => conversations.close())
    window.once('closed', () => {
      conversations.close()
      ipcMain.removeListener(operationDiagnosticsChannel, receiveConversation)
      ipcMain.removeHandler(operationDiagnosticsChannel)
    })
    ipcMain.handle(operationDiagnosticsChannel, async (event, method, value) => {
      if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) return
      if (method === 'importRefresh' && value && typeof value.jobId === 'string'
        && (value.createdAt === undefined || Number.isSafeInteger(value.createdAt))
        && ['success', 'failed', 'unknown'].includes(value.result)) {
        await imports.refresh(value.jobId, value.createdAt, value.result)
      }
    })
    ipcMain.handle(importDiagnosticsChannel, async (event, operation: unknown, value: unknown) => {
      try {
        if (window.isDestroyed() || !isTrustedCaller(event, window, appUrl)) throw new BoundaryError('UNTRUSTED_CALLER', '请在应用窗口中操作。')
        if (operation === 'report') await importDiagnostics.report(value)
        else if (operation === 'open') {
          if (value && typeof value === 'object') {
            if (!('operationId' in value) || !isOperationId(value.operationId) || !('jobId' in value)
              || (value.jobId != null && !localId(value.jobId))) throw new BoundaryError('INVALID_ARGUMENT')
            const id = value.operationId
            const found = (await operations.list()).some(item => item.id === id && item.area === 'import')
            if (found) {
              try {
                await operations.withFile(id, async path => {
                  if (await shell.openPath(path)) throw new BoundaryError('IMPORT_LOG_OPEN_FAILED', '无法打开日志。请检查默认文本查看应用后重试。')
                }, true)
              } catch (error) {
                if (!(error instanceof BoundaryError) || error.code !== 'DIAGNOSTIC_NOT_FOUND' || value.jobId == null) throw error
                await importDiagnostics.open(value.jobId)
              }
            } else if (value.jobId != null) await importDiagnostics.open(value.jobId)
            else throw new BoundaryError('IMPORT_LOG_MISSING', '找不到这次操作的日志。')
          } else await importDiagnostics.open(value)
        }
        else throw new BoundaryError('INVALID_ARGUMENT')
        return { ok: true }
      } catch (error) { return { ok: false, error: serializableError(error) } }
    })
    window.once('closed', () => { locations.revokeOwner(windowId); stopWindowEvents(); stopAiWindow(); aiRouter.release(windowId); router.releaseWindow(windowId); ipcMain.removeHandler(settingsChannel); ipcMain.removeHandler(aiChannels.call); ipcMain.removeHandler(desktopChannels.call); ipcMain.removeHandler(desktopChannels.drop); ipcMain.removeHandler(importDiagnosticsChannel) })
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const link = new URL(url)
        if (['https:', 'http:'].includes(link.protocol) && link.hostname && !link.username && !link.password && url.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(url)) {
          void shell.openExternal(link.href).catch(error => {
            void appErrorLogs.record({ area: 'main', phase: 'openExternal', error })
            if (!window.isDestroyed()) window.webContents.send(appExceptionChannel, { title: '无法打开链接', detail: '请将链接复制到浏览器中打开。' })
          })
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
    operations.event(startup, 'windowReady')
    operations.end(startup, 'success')
  }).catch(async error => {
    if (quitting) return
    const code = error instanceof BoundaryError ? error.code : 'STARTUP_FAILED'
    operations.end(startup, 'failed', { code })
    await finishReopen(false, code).catch(() => {})
    const logDirectory = await appErrorLogs.record({ area: 'startup', phase: 'initialize', error: error instanceof BoundaryError ? error : new BoundaryError('STARTUP_FAILED') })
    const detail = error instanceof BoundaryError && error.code.startsWith('STORAGE_')
      ? `${error.message}\n连接保存会话的磁盘或恢复原保存目录后，重新打开 Whomi。`
      : '无法打开本地数据。请检查保存目录是否可访问，然后重新打开 Whomi。'
    if (probeEnabled) console.error('Whomi test startup failed:', serializableError(error).code, logDirectory ?? 'ERROR_LOG_UNWRITABLE')
    else dialog.showErrorBox('Whomi 无法启动', detail + (logDirectory
      ? `\n打开 ${logDirectory} 查看错误日志。`
      : `\n${appErrorLogs.writeFailureAction}`))
    await Promise.allSettled([agentHost?.close(), dataHost?.close()])
    await operations.close()
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
        await appErrorLogs.flush()
        await operations.close()
      })().finally(() => app.quit())
    }
  })
}
