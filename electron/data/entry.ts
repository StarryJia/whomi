import { openStore } from './db/open'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { validateRuntimeTestDirectory } from '../runtime-test-directory'
import { createDataService } from './service'
import { createCommitter } from './import/merge'
import { createDataDispatcher } from './dispatch'
import { createAiRepository } from './ai/repository'
import { BoundaryError, validateSnapshot } from '../../src/shared/desktop-validation'
import { ImportFailure, issue } from './import/limits'

const probeEnabled = process.argv.includes('--runtime-probe')
const directory = probeEnabled ? validateRuntimeTestDirectory(process.argv[2]) : process.argv[2]
mkdirSync(directory, { recursive: true })
const store = openStore(join(directory, 'whomi.db'))
const { writer: database, reader } = store
const service = createDataService({store,appDataDirectory:directory,changed(snapshot) {
  validateSnapshot(snapshot)
  parent.postMessage({ event: 'import', value: snapshot })
}})
const aiRepository = createAiRepository(store, service.write)
const ready = service.ready.then(() => aiRepository.recover())
const dispatch = createDataDispatcher(store, service, aiRepository)
const version = database.prepare('SELECT sqlite_version() AS version').get() as { version: string }
const parent = (process as unknown as { parentPort: { on(event: string, callback: (event: { data: { id: number; method: string; payload: unknown } }) => void): void; postMessage(value: unknown): void } }).parentPort
// 辅助探针来自测试临时目录，正式安装资源不包含探针。
const probe = probeEnabled
  ? createRequire(join(directory, 'runtime.cjs'))(join(directory, 'probe.cjs'))(database, reader, {store,service,createDataService,createCommitter,directory}) as (method: string) => unknown
  : undefined
parent.on('message', async ({ data }) => {
  try {
    await ready
    let result: unknown
    if (data.method === 'health') result = { runtime: process.versions.node, sqliteVersion: version.version, writable: !database.readonly }
    else if (probe && data.method.startsWith('probe.')) result = await probe(data.method)
    else result = await dispatch(data.method, data.payload)
    parent.postMessage({ id: data.id, result })
  } catch(error) {
    const failure = error instanceof BoundaryError ? {code:error.code,action:error.action}
      : error instanceof ImportFailure ? {code:error.code,action:error.code==='PREVIEW_UNAVAILABLE' ? '请重新选择来源并暂存后预览。':issue(error.code).action}
      : (error as {code?:string})?.code==='INVALID_CURSOR' ? {code:'INVALID_CURSOR',action:'请刷新阅读位置后重试。'}
      : {code:'OPERATION_FAILED',action:'操作失败，请重试。'}
    parent.postMessage({ id: data.id, error: failure })
  }
})
process.on('exit', () => store.close())
