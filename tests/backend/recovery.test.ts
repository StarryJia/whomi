import { expect,test,beforeAll,afterAll } from 'vitest'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,writeFile,readFile,readdir,rm,symlink,rmdir,unlink } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { recoverImports } from '../../electron/data/import/recovery'
import { createImportDiagnostics } from '../../electron/main/import-diagnostics'
import type { PersistedImportFailure, StoredImportDiagnostic } from '../../src/shared/import-diagnostics'
import { operationRetentionMs } from '../../src/shared/operation-diagnostics'
import { openStore } from '../../electron/data/db/open'
import { getSnapshot } from '../../electron/data/import/state'
import { createSnapshotArea } from '../../electron/data/import/snapshot'
import { commitConversation } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { candidate,view } from './import-fixture'
import { temporaryStore } from './helpers'
import { createDataService } from '../../electron/data/service'
import { createDataDispatcher } from '../../electron/data/dispatch'
import { createDesktopClient } from '../../src/data/desktop-client'
let childBundle:string,bundleDirectory:string
beforeAll(async()=> {
  bundleDirectory=await mkdtemp(join(tmpdir(),'whomi-child-'));childBundle=join(bundleDirectory,'child.cjs')
  const {rolldown}=await import('rolldown')
  const bundle=await rolldown({input:'tests/backend/crash-child.ts',platform:'node',external:['better-sqlite3']})
  await bundle.write({file:childBundle,format:'cjs'});await bundle.close()
})
afterAll(async()=> {await rm(bundleDirectory,{recursive:true,force:true})})
test('the desktop client can recover only the latest interrupted import without a saved job ID', async () => {
  const temp = temporaryStore()
  const store = openStore(temp.path)
  try {
    const insert = store.writer.prepare('INSERT INTO import_jobs(id,status,phase,created_at_ms) VALUES(?,?,?,0)')
    insert.run(1, 'running', 'scanning')
    const service = createDataService({ store, appDataDirectory: dirname(temp.path) })
    const dispatch = createDataDispatcher(store, service)
    expect(await dispatch('getInterruptedImport', [])).toBe('1')
    const client = createDesktopClient({ invoke: async (method, args) => ({ ok: true, value: await dispatch(method, args) }), onImport: () => () => {} })
    expect(await client.getInterruptedImport()).toBe('1')
    expect(await client.getImport('1')).toMatchObject({ failurePhase: 'scan', issues: [{ code: 'INTERRUPTED' }] })

    insert.run(2, 'running', 'scanning')
    expect(await client.getInterruptedImport()).toBeNull()
    for (const status of ['completed', 'cancelled']) {
      store.writer.prepare('UPDATE import_jobs SET status=?,phase=? WHERE id=2').run(status, status)
      expect(await client.getInterruptedImport()).toBeNull()
    }
    const oldIssue = { code: 'INTERRUPTED', severity: 'blocking', candidateId: '', action: '导入已中断。' }
    store.writer.prepare("UPDATE import_jobs SET status='failed',phase='failed',metadata=? WHERE id=2").run(JSON.stringify({
      failurePhase: 'cancel', issues: [{ ...oldIssue, code: 'CANCEL_FAILED' }], discovery: { issues: [oldIssue] },
    }))
    expect(await client.getInterruptedImport()).toBeNull()
    await expect(dispatch('getInterruptedImport', ['1'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  } finally { store.close(); temp.cleanup() }
})

test('startup provides counted diagnostics for an interrupted import before the renderer opens a page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-startup-import-'))
  const store = openStore(join(directory, 'whomi.db'))
  try {
    const counts = { seen: 4, validRecords: 4, invalidRecords: 0 }
    store.writer.prepare("INSERT INTO import_jobs(id,status,phase,created_at_ms,metadata) VALUES(1,'running','awaiting_commit',0,?)")
      .run(JSON.stringify({ counts }))
    const service = createDataService({ store, appDataDirectory: directory })
    const dispatch = createDataDispatcher(store, service)
    const expected = [{ diagnostic: { jobId: '1', phase: 'parse', code: 'INTERRUPTED' }, counts, jobCreatedAt: 0 }]
    expect(await dispatch('unresolvedImportDiagnostics', null)).toEqual(expected)

    const restarted = createDataDispatcher(store, createDataService({ store, appDataDirectory: directory }))
    expect(await restarted('unresolvedImportDiagnostics', null)).toEqual(expected)
    await service.cancelImport('1')
    expect(await restarted('unresolvedImportDiagnostics', null)).toEqual([])
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test('startup and a restored failure page retain the original expiry and never recreate a pruned attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-import-replay-'))
  const databasePath = join(directory, 'whomi.db')
  let store = openStore(databasePath)
  const logs = join(directory, 'import-errors')
  try {
    const recentlyEnded = Date.now() - operationRetentionMs + 86_400_000
    const expired = Date.now() - operationRetentionMs - 86_400_000
    const metadata = JSON.stringify({ failurePhase: 'scan', issues: [{ severity: 'blocking', code: 'SOURCE_UNREADABLE' }] })
    const insert = store.writer.prepare("INSERT INTO import_jobs(id,status,phase,created_at_ms,completed_at_ms,metadata) VALUES(?,'failed','failed',?,?,?)")
    insert.run(1, expired, expired, metadata)
    insert.run(2, expired, recentlyEnded, metadata)
    const connect = () => createDataDispatcher(store, createDataService({ store, appDataDirectory: directory }))
    let dispatch = connect()
    const lookup = async (id: string) => await dispatch('getImportDiagnosticFailure', id) as PersistedImportFailure
    const outstanding = async () => await dispatch('unresolvedImportDiagnostics', null) as StoredImportDiagnostic[]
    const reporter = () => createImportDiagnostics(directory, '1.0.0', async () => '', undefined, undefined, {
      find: lookup, acknowledge: async receipt => { await dispatch('acknowledgeImportDiagnostic', receipt) },
    })
    const [recent] = await outstanding()
    expect((await outstanding()).map(item => item.diagnostic.jobId)).toEqual(['2'])
    await writeFile(logs, 'blocked')
    await expect(reporter().report(recent.diagnostic)).rejects.toMatchObject({ code: 'IMPORT_LOG_WRITE_FAILED' })
    expect(await outstanding()).toEqual([recent])
    await unlink(logs)
    const original = await lookup('2')
    await reporter().report(recent.diagnostic)
    const [filename] = await readdir(logs)
    expect(filename).toMatch(new RegExp('^' + recentlyEnded + '-'))
    expect(JSON.parse(await readFile(join(logs, filename), 'utf8')).recordedAt).toBe(new Date(recentlyEnded).toISOString())
    await unlink(join(logs, filename))
    for (let restart = 0; restart < 2; restart++) {
      store.close()
      store = openStore(databasePath)
      dispatch = connect()
      expect(await outstanding()).toEqual([])
      const log = reporter()
      await log.report((await lookup('1')).diagnostic)
      await log.report(recent.diagnostic)
      expect(await readdir(logs)).toEqual([])
    }
    store.writer.prepare("UPDATE import_jobs SET metadata=json_set(metadata,'$.failurePhase','cancel') WHERE id=2").run()
    await dispatch('acknowledgeImportDiagnostic', original.receipt)
    expect((await outstanding()).map(item => item.diagnostic.phase)).toEqual(['cancel'])
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test.each(['beforeCommit','afterCommit','afterFirstTarget'])('recovers an actual child killed at %s without losing committed state',async boundary=> {
  const temp=temporaryStore()
  let store:ReturnType<typeof openStore>|undefined
  const child=fork(childBundle,[temp.path,boundary],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,NODE_PATH:resolve('node_modules')}})
  try {
    await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('child exited early')}),new Promise((_,reject)=>setTimeout(()=>reject(Error('boundary timeout')),15000))])
    child.kill('SIGKILL');await once(child,'exit')
    store=openStore(temp.path);await recoverImports(store)
    expect(store.reader.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:boundary==='afterCommit' ? 3n:0n})
    expect((getSnapshot(store,'1')).status).toBe(boundary==='afterCommit' ? 'completed':'failed')
    if (boundary === 'afterFirstTarget') {
      expect(store.reader.prepare('SELECT count(*) n FROM conversations').get()).toEqual({n:0n})
      expect(getSnapshot(store,'1')).toMatchObject({failurePhase:'save',issues:[{code:'INTERRUPTED'}]})
    }
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
