import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { validateRuntimeTestDirectory } from '../runtime-test-directory'
import { startDataHost } from './data-host'
import type { DataHost } from './data-host'

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
let quitting = false
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    dataHost = startDataHost(app.getPath('userData'))
    if (probeEnabled) (globalThis as typeof globalThis & { __whomiRuntimeProbe?: DataHost }).__whomiRuntimeProbe = dataHost
    await dataHost.request('health', null)
    const window = new BrowserWindow({ webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const pagePath = join(__dirname, '../renderer/index.html')
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
      void dataHost.close().finally(() => app.quit())
    }
  })
}
