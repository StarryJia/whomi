import { act } from '@testing-library/react'

function messageHeight(target: Element) {
  if (target.hasAttribute('data-message-virtual-list-scroller')) return 640
  if (target.firstElementChild?.hasAttribute('data-message-index')) return 120
}

/** Give the real virtualizer viewport and row measurements in JSDOM. */
export function installCherryMessageGeometry() {
  globalThis.ResizeObserver = class {
    private readonly pending = new Map<Element, number>()
    private scheduled = false

    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element) {
      const height = messageHeight(target)
      if (height === undefined) return
      Object.defineProperty(target, 'offsetParent', { configurable: true, get: () => target.parentElement })
      this.pending.set(target, height)
      if (this.scheduled) return
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        const entries = [...this.pending].flatMap(([element, itemHeight]) => element.isConnected
          ? [{ target: element, contentRect: new DOMRect(0, 0, 480, itemHeight),
              borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }]
          : [])
        this.pending.clear()
        if (entries.length > 0) act(() => this.callback(entries, this))
      })
    }

    unobserve(target: Element) {
      this.pending.delete(target)
    }

    disconnect() {
      this.pending.clear()
    }
  }
}
