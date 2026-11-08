export function createAnimationFrameResizeObserver(ownerWindow, callback) {
  const pending = new Map()
  let frame = null

  // Virtua commits item sizes synchronously, which can resize observed nodes during delivery.
  const observer = new ownerWindow.ResizeObserver(entries => {
    for (const entry of entries) pending.set(entry.target, entry)
    if (frame !== null) return
    frame = ownerWindow.requestAnimationFrame(() => {
      frame = null
      const batch = [...pending.values()]
      pending.clear()
      callback(batch)
    })
  })

  const cancelEmptyFrame = () => {
    if (frame === null || pending.size !== 0) return
    ownerWindow.cancelAnimationFrame(frame)
    frame = null
  }

  return {
    observe(target) {
      observer.observe(target)
    },
    unobserve(target) {
      observer.unobserve(target)
      pending.delete(target)
      cancelEmptyFrame()
    },
    disconnect() {
      observer.disconnect()
      pending.clear()
      cancelEmptyFrame()
    },
  }
}
