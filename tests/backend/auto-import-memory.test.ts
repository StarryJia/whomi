import { expect,test } from 'vitest'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { temporaryStore } from './helpers'

test('matches a million-record stream within a 64 MiB JavaScript heap',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'whomi-match-memory-')),temp=temporaryStore()
  const {rolldown}=await import('rolldown')
  const bundle=await rolldown({input:'tests/backend/auto-import-memory-child.ts',platform:'node',external:['better-sqlite3']})
  const path=join(directory,'child.cjs');await bundle.write({file:path,format:'cjs'});await bundle.close()
  const child=fork(path,[temp.path],{execArgv:['--max-old-space-size=64'],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_PATH:resolve('node_modules')}})
  let report:unknown,errors=''
  child.on('message',value=>{report=value});child.stderr?.on('data',value=>{errors=(errors+String(value)).slice(-8192)})
  try {
    const [code]=await once(child,'exit')
    expect(code,errors).toBe(0)
    expect(report).toMatchObject({processed:1000000,status:'matched'})
  }finally{if(child.exitCode===null)child.kill();temp.cleanup();await rm(directory,{recursive:true,force:true})}
},30000)

test('deduplicates 250000 same-timestamp records within a 64 MiB JavaScript heap',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'whomi-dedup-memory-')),temp=temporaryStore()
  const {rolldown}=await import('rolldown')
  const bundle=await rolldown({input:'tests/backend/auto-import-dedup-memory-child.ts',platform:'node',external:['better-sqlite3']})
  const path=join(directory,'child.cjs');await bundle.write({file:path,format:'cjs'});await bundle.close()
  const child=fork(path,[temp.path],{execArgv:['--max-old-space-size=64'],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_PATH:resolve('node_modules')}})
  let report:unknown,errors=''
  child.on('message',value=>{report=value});child.stderr?.on('data',value=>{errors=(errors+String(value)).slice(-8192)})
  try {
    const [code]=await once(child,'exit')
    expect(code,errors).toBe(0)
    expect(report).toMatchObject({inserted:0,duplicates:250000})
  }finally{if(child.exitCode===null)child.kill();temp.cleanup();await rm(directory,{recursive:true,force:true})}
},60000)
