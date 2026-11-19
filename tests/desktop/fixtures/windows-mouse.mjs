import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const invoke = promisify(execFile)
const script = fileURLToPath(new URL('./windows-mouse.ps1', import.meta.url))

export async function windowsMouse(application, x, y, toX = x, toY = y) {
  const { handle, start, end } = await application.evaluate(({ BrowserWindow, screen }, points) => {
    const window = BrowserWindow.getAllWindows()[0]
    const origin = window.getContentBounds()
    const physical = (x, y) => screen.dipToScreenPoint({ x: Math.round(origin.x + x), y: Math.round(origin.y + y) })
    const buffer = window.getNativeWindowHandle()
    return {
      handle: String(buffer.length === 8 ? buffer.readBigUInt64LE() : buffer.readUInt32LE()),
      start: physical(points.x, points.y),
      end: physical(points.toX, points.toY),
    }
  }, { x, y, toX, toY })
  await invoke('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-WindowHandle', handle, '-X', String(start.x), '-Y', String(start.y), '-ToX', String(end.x), '-ToY', String(end.y),
  ], { timeout: 12_000, windowsHide: true })
}
