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
      const hook=method==='probe.crashBefore' ? 'beforeCommit':'afterCommit'
      const service=backend.createDataService({store:backend.store,appDataDirectory:backend.directory,runner:{commit:backend.createCommitter({[hook](){process.exit(77)}})}})
      const id=await staged(service)
      await service.startImport({kind:'commit',plan:{jobId:id,decisions:[]}})
      await service.idle()
      throw Error('Expected process exit')
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
