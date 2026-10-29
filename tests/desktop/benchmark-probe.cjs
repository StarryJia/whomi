module.exports = (writer, reader, backend) => {
  const { join } = require('node:path')
  const { performance } = require('node:perf_hooks')
  let baselineRss = process.memoryUsage().rss
  const stats = () => ({ node: process.versions.node, electron: process.versions.electron, sqlite: writer.prepare('SELECT sqlite_version() v').get().v, baselineRssBytes: baselineRss, peakRssBytes: process.resourceUsage().maxRSS * 1024 })
  async function stage(service, path) {
    const id = await service.prepareImport([{ rootPath: path }])
    const discovery = (await service.getImport(id)).discovery
    await service.startImport({ kind: 'stage', jobId: id, entryIds: discovery.entries.map(entry => entry.entryId) })
    await service.idle()
    const snapshot = await service.getImport(id)
    if (snapshot.status !== 'awaiting_commit' || snapshot.candidates.some(c => c.status !== 'staged')) throw Error('Benchmark staging failed')
    return id
  }
  return async method => {
    if (method === 'probe.benchmark') {
      baselineRss = process.memoryUsage().rss
      const start = performance.now(), service = backend.service
      const id = await stage(service, join(backend.directory, 'sources'))
      const stagedMs = performance.now() - start
      await service.startImport({ kind: 'commit', plan: { jobId: id, decisions: [] } }); await service.idle()
      const snapshot = await service.getImport(id)
      if (snapshot.status !== 'completed') throw Error('Benchmark import failed')
      return { ...stats(), importMs: performance.now()-start, stageMs: stagedMs, inserted: snapshot.inserted }
    }
    if (method === 'probe.cancel') {
      let requestAt, acceptedAt, returnedAt, pending
      const service = backend.createDataService({ store: backend.store, appDataDirectory: backend.directory, runner: { commit: async (store, staged, target, signal) => {
        signal.addEventListener('abort', () => { acceptedAt = performance.now() }, { once: true })
        return backend.createCommitter({ afterInsert(count) {
          if (count === 500) setImmediate(() => { requestAt = performance.now(); pending = service.cancelImport(id).then(() => { returnedAt = performance.now() }) })
        } })(store, staged, target, signal)
      } } })
      const before = reader.prepare('SELECT count(*) n FROM messages').get().n
      const id = await stage(service, join(backend.directory, 'cancel.jsonl'))
      await service.startImport({ kind: 'commit', plan: { jobId: id, decisions: [] } }); await service.idle(); await pending
      const snapshot = await service.getImport(id)
      if (!acceptedAt || snapshot.status !== 'cancelled' || reader.prepare('SELECT count(*) n FROM messages').get().n !== before) throw Error('Cancellation rollback failed')
      return { cancelAcceptedMs: acceptedAt-requestAt, cancelCompletionMs: returnedAt-requestAt, rollbackAfterAcceptanceMs: returnedAt-acceptedAt, status: snapshot.status, ...stats() }
    }
    throw Error('Unsupported benchmark probe')
  }
}
