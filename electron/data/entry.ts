import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { validateRuntimeTestDirectory } from '../runtime-test-directory'

const probeEnabled = process.argv.includes('--runtime-probe')
const directory = probeEnabled ? validateRuntimeTestDirectory(process.argv[2]) : process.argv[2]
mkdirSync(directory, { recursive: true })
const database = new Database(join(directory, 'whomi.db'))
database.pragma('journal_mode = WAL')
database.pragma('foreign_keys = ON')
database.pragma('synchronous = FULL')
database.pragma('busy_timeout = 5000')
const version = database.prepare('SELECT sqlite_version() AS version').get() as { version: string }
const [major, minor, patch] = version.version.split('.').map(Number)
if (major * 1000000 + minor * 1000 + patch < 3051003) throw new Error('请升级数据库运行环境。')
const reader = new Database(join(directory, 'whomi.db'), { readonly: true })
reader.pragma('foreign_keys = ON')
reader.pragma('busy_timeout = 5000')
const parent = (process as unknown as { parentPort: { on(event: string, callback: (event: { data: { id: number; method: string } }) => void): void; postMessage(value: unknown): void } }).parentPort
// 辅助探针来自测试临时目录，正式安装资源不包含探针。
const probe = probeEnabled
  ? createRequire(join(directory, 'runtime.cjs'))(join(directory, 'probe.cjs'))(database, reader) as (method: string) => unknown
  : undefined
parent.on('message', async ({ data }) => {
  try {
    let result: unknown
    if (data.method === 'health') result = { runtime: process.versions.node, sqliteVersion: version.version, writable: !database.readonly }
    else if (probe && data.method.startsWith('probe.')) result = await probe(data.method)
    else throw new Error('请选择可用操作。')
    parent.postMessage({ id: data.id, result })
  } catch { parent.postMessage({ id: data.id, error: '操作失败，请重试。' }) }
})
process.on('exit', () => { reader.close(); database.close() })
