export type SampleElapsed = () => { elapsedMs: number; sampledAtMs: number }

export async function withInsightClock<T>(
  previousElapsedMs: number, signal: AbortSignal, saveElapsed: ((ms: number, sampledAt: number) => Promise<void>) | undefined,
  run: (sample: SampleElapsed, persist: (operation: () => Promise<void>) => Promise<void>) => Promise<T>, clock = Date.now,
): Promise<T> {
  const startedAtMs = clock()
  let sampledAtMs = startedAtMs
  // 状态提交和计时采样都可能晚于最后一个完整断点。
  const sampleElapsed: SampleElapsed = () => {
    sampledAtMs = Math.max(sampledAtMs, clock())
    return { elapsedMs: previousElapsedMs + sampledAtMs - startedAtMs, sampledAtMs }
  }
  let write: Promise<void> | undefined
  async function persist(operation: () => Promise<void>) {
    const pending = Promise.resolve(write).then(operation)
    write = pending
    try { await pending } finally { if (write === pending) write = undefined }
  }

  if (!saveElapsed) return run(sampleElapsed, persist)
  const timer = setInterval(() => {
    if (signal.aborted || write) return
    const sample = sampleElapsed()
    void persist(async () => {
      try { await saveElapsed(sample.elapsedMs, sample.sampledAtMs) }
      catch { /* 下一次采样或完整断点会继续持久化用时。 */ }
    })
  }, 5000)
  timer.unref()
  try {
    return await run(sampleElapsed, persist)
  } finally {
    clearInterval(timer)
    await write
  }
}
