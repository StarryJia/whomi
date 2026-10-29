/** Event callbacks run outside the promise executor's exception boundary. */
export function streamGuard(reject: (error: unknown) => void, ...streams: { destroy(): unknown }[]) {
  let failed = false
  return function guard<Args extends unknown[]>(callback: (...args: Args) => void) {
    return (...args: Args) => {
      if (failed) return
      try { callback(...args) }
      catch (error) {
        failed = true
        reject(error)
        for (const stream of streams) stream.destroy()
      }
    }
  }
}
