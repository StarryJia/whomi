import '@testing-library/jest-dom/vitest'

// jsdom 不提供布局滚动和指针捕获，原生桌面另行验证这些行为。
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {}
if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false
if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {}
// 光标与页面滚动的真实几何在桌面用例验证；jsdom 无命中测试与滚动布局。
if (!document.elementFromPoint) document.elementFromPoint = () => null
window.scrollBy = () => {}
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { installCherryMessageGeometry } from './cherry-message-geometry'

// jsdom 不执行布局测量，提示组件通过此接口订阅真实浏览器中的尺寸变化。
installCherryMessageGeometry()

beforeEach(() => {
  const caretRect = new DOMRect(0, 0, 16, 16)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => caretRect })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [caretRect] })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})
