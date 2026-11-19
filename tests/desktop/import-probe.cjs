module.exports = (writer, reader, backend) => {
  async function staged(service) {
    const {join}=require('node:path')
    const id=await service.prepareImport([{rootPath:join(backend.directory,'source.json')}])
    const discovery=(await service.getImport(id)).discovery
    await service.startImport({kind:'stage',jobId:id,entryIds:discovery.entries.map(e=>e.entryId)})
    await service.idle()
    return id
  }
  return async method => {
    if(method==='probe.crashBefore' || method==='probe.crashAfter') {
      const id = await staged(backend.service)
      const exec = writer.exec
      // 单个会话只释放保存点。整批写入由外层 COMMIT 持久化。
      writer.exec = function (sql) {
        if (sql !== 'COMMIT' || !this.inTransaction) return exec.call(this, sql)
        if (method === 'probe.crashBefore') process.exit(77)
        exec.call(this, sql)
        process.exit(77)
      }
      try {
        await backend.service.startImport({ kind: 'commit', plan: { jobId: id, decisions: [] } })
        await backend.service.idle()
        throw Error('Expected process exit')
      } finally {
        writer.exec = exec
      }
    }
    if(method==='probe.recovered')return {snapshot:await backend.service.getImport('1'),count:Number(reader.prepare('SELECT count(*) n FROM messages').get().n),integrity:writer.pragma('integrity_check',{simple:true})}
    if(method==='probe.reimport') {
      const id=await staged(backend.service)
      await backend.service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}});await backend.service.idle()
      return backend.service.getImport(id)
    }
    throw Error('Unsupported probe')
  }
}
