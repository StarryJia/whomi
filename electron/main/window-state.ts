import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen, type BrowserWindow, type Rectangle } from 'electron'

type WindowState = Rectangle & { maximized: boolean }

export function loadWindowState(directory: string) {
  const primary = screen.getPrimaryDisplay().workArea
  let saved: WindowState | undefined
  try {
    const value = JSON.parse(readFileSync(join(directory, 'window-state.json'), 'utf8'))
    if (['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key])) && value.width > 0 && value.height > 0) saved = value
  } catch { /* 首次启动或配置损坏时使用默认尺寸。 */ }
  const visible = saved && screen.getAllDisplays().some(({ workArea }) =>
    saved!.x < workArea.x + workArea.width && saved!.x + saved!.width > workArea.x &&
    saved!.y < workArea.y + workArea.height && saved!.y + saved!.height > workArea.y)
  const area = visible && saved ? screen.getDisplayMatching(saved).workArea : primary
  const width = Math.min(area.width, Math.max(Math.min(960, area.width), saved?.width ?? 1200))
  const height = Math.min(area.height, Math.max(Math.min(640, area.height), saved?.height ?? 800))
  const bounds = {
    width, height,
    x: saved && visible ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2),
    y: saved && visible ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : Math.round(area.y + (area.height - height) / 2),
    minWidth: Math.min(960, area.width), minHeight: Math.min(640, area.height),
  }
  return { bounds, maximized: saved?.maximized === true }
}

export function rememberWindowState(window: BrowserWindow, directory: string) {
  window.on('close', () => {
    try {
      writeFileSync(join(directory, 'window-state.json'), JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }))
    } catch { /* 窗口偏好保存失败不阻止退出。 */ }
  })
}
