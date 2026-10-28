import Database from 'better-sqlite3'
import { migrateStore } from './migrate'
import { schemaVersion } from './schema'
export type Store = { writer: Database.Database; reader: Database.Database; close(): void }
export function openStore(path: string): Store {
  const writer = new Database(path)
  let reader: Database.Database | undefined
  try {
    writer.defaultSafeIntegers(true)
    if ((writer.pragma('user_version', {simple:true}) as bigint) > BigInt(schemaVersion)) throw new Error('请升级应用后打开资料库。')
    const { version } = writer.prepare('SELECT sqlite_version() AS version').get() as {version:string}
    const [major,minor,patch] = version.split('.').map(Number)
    if (major*1000000+minor*1000+patch < 3051003) throw new Error('请升级数据库运行环境。')
    writer.pragma('journal_mode = WAL'); writer.pragma('foreign_keys = ON'); writer.pragma('synchronous = FULL'); writer.pragma('busy_timeout = 5000')
    migrateStore({writer})
    reader = new Database(path, {readonly:true, fileMustExist:true})
    reader.defaultSafeIntegers(true); reader.pragma('foreign_keys = ON'); reader.pragma('busy_timeout = 5000')
    return { writer, reader, close() { if (reader?.open) reader.close(); if (writer.open) writer.close() } }
  } catch (error) { if (reader?.open) reader.close(); if (writer.open) writer.close(); throw error }
}
