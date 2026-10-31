// Adapted from Cherry Studio EditModelDrawer's coalescing auto-save queue (AGPL-3.0).
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from './common'

export function useAutoSave<T>(persist: (input: T) => Promise<void>) {
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const operation = useRef(persist); operation.current = persist
  const queued = useRef<T | null>(null), failed = useRef<T | null>(null), running = useRef<Promise<boolean> | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const process = useCallback((): Promise<boolean> => {
    if (running.current) return running.current
    setPending(true); setError('')
    const task = (async () => {
      let succeeded = true
      while (queued.current !== null) {
        const input = queued.current; queued.current = null
        try { await operation.current(input); failed.current = null; if (mounted.current) setError('') }
        catch (cause) { succeeded = false; failed.current = queued.current ?? input; queued.current = null; if (mounted.current) setError(errorText(cause)); break }
      }
      return succeeded
    })()
    running.current = task
    void task.finally(() => { running.current = null; if (mounted.current) setPending(false) })
    return task
  }, [])
  const save = useCallback((input: T) => { queued.current = input; return process() }, [process])
  const retry = useCallback(() => { if (failed.current !== null) return save(failed.current); return Promise.resolve(true) }, [save])
  return { pending, error, save, retry, flush: () => running.current ?? Promise.resolve(!failed.current) }
}
