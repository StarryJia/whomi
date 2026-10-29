import { expect,test,beforeAll,afterAll } from 'vitest'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,writeFile,readFile,rm,symlink,rmdir,unlink } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { recoverImports } from '../../electron/data/import/recovery'
import { openStore } from '../../electron/data/db/open'
import { getSnapshot } from '../../electron/data/import/state'
import { createSnapshotArea } from '../../electron/data/import/snapshot'
import { commitConversation } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { candidate,view } from './import-fixture'
import { temporaryStore } from './helpers'
let childBundle:string,bundleDirectory:string
beforeAll(async()=> {
  bundleDirectory=await mkdtemp(join(tmpdir(),'whomi-child-'));childBundle=join(bundleDirectory,'child.cjs')
  const {rolldown}=await import('rolldown')
  const bundle=await rolldown({input:'tests/backend/crash-child.ts',platform:'node',external:['better-sqlite3']})
  await bundle.write({file:childBundle,format:'cjs'});await bundle.close()
})
afterAll(async()=> {await rm(bundleDirectory,{recursive:true,force:true})})
test.each(['beforeCommit','afterCommit'])('recovers an actual child killed at %s without losing committed state',async boundary=> {
  const temp=temporaryStore()
  let store:ReturnType<typeof openStore>|undefined
  const child=fork(childBundle,[temp.path,boundary],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,NODE_PATH:resolve('node_modules')}})
  try {
    await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('child exited early')}),new Promise((_,reject)=>setTimeout(()=>reject(Error('boundary timeout')),15000))])
    child.kill('SIGKILL');await once(child,'exit')
    store=openStore(temp.path);await recoverImports(store)
    expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:boundary==='beforeCommit' ? 0n:3n})
    expect((getSnapshot(store,'1')).status).toBe(boundary==='beforeCommit' ? 'failed':'completed')
    if(boundary==='afterCommit') {
      const id=store.writer.prepare("INSERT INTO import_jobs(status,created_at_ms) VALUES ('running',0)").run().lastInsertRowid.toString()
      const c=candidate('retry'),r=resolveTarget(store,c)
      if(r.status!=='matched')throw Error('target')
      expect(await commitConversation(store,view(id,[c],[['m1','m2','m3']]),r.target,new AbortController().signal)).toMatchObject({inserted:0,duplicates:3})
      store.writer.prepare("UPDATE import_jobs SET status='failed',phase='failed' WHERE id=1").run()
      await recoverImports(store)
      expect(getSnapshot(store,'1').results[0].status).toBe('saved')
      expect(getSnapshot(store,'1').status).toBe('completed')
    }
    expect(store.writer.pragma('integrity_check',{simple:true})).toBe('ok')
    expect(store.writer.pragma('foreign_key_check')).toEqual([])
  } finally {if(child.exitCode===null)child.kill();store?.close();temp.cleanup()}
},20000)
test('cleans registered owned staging only and preserves source and unrelated files',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'whomi-recovery-')),store=openStore(join(directory,'formal.db'))
  try {
    const area=createSnapshotArea(directory),owned=await area.create(),record=area.ownership(owned)
    await writeFile(join(owned,'unfinished'),'example');await writeFile(join(directory,'source.json'),'preserved')
    const unrelated=join(record.root,'unregistered');await writeFile(unrelated,'preserved')
    store.writer.exec("INSERT INTO import_jobs(id,status,phase,created_at_ms) VALUES (1,'running','staging',0)")
    store.writer.prepare('INSERT INTO import_staging_areas VALUES (1,?,?,?,?)').run(record.path,record.appDirectory,record.root,record.identity)
    await recoverImports(store)
    await expect(readFile(join(owned,'unfinished'))).rejects.toThrow()
    expect(await readFile(join(directory,'source.json'),'utf8')).toBe('preserved')
    expect(await readFile(unrelated,'utf8')).toBe('preserved')
  }finally {store.close();await rm(directory,{recursive:true,force:true})}
})
test('refuses cleanup after the registered staging parent becomes a junction',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'whomi-recovery-')),outside=await mkdtemp(join(tmpdir(),'whomi-sentinel-')),store=openStore(join(directory,'formal.db'))
  let root:string|undefined
  try {
    const area=createSnapshotArea(directory),owned=await area.create(),record=area.ownership(owned)
    store.writer.exec("INSERT INTO import_jobs(id,status,phase,created_at_ms) VALUES (1,'running','staging',0)")
    store.writer.prepare('INSERT INTO import_staging_areas VALUES (1,?,?,?,?)').run(record.path,record.appDirectory,record.root,record.identity)
    await rm(owned,{recursive:true});await rmdir(record.root);await writeFile(join(outside,'sentinel'),'keep');await symlink(outside,record.root,'junction');root=record.root
    await recoverImports(store)
    expect(await readFile(join(outside,'sentinel'),'utf8')).toBe('keep')
    expect(store.reader.prepare('SELECT count(*) n FROM import_staging_areas').get()).toEqual({n:1n})
  }finally {store.close();if(root)await unlink(root);await rm(directory,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
})
