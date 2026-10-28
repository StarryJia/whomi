import type { Store } from './open'
import { schema, schemaVersion } from './schema'
export function migrateStore(store: Pick<Store, 'writer'>): void {
  const db = store.writer
  const version = db.pragma('user_version', { simple: true }) as bigint
  if (version > BigInt(schemaVersion)) throw new Error('请升级应用后打开资料库。')
  if (version === BigInt(schemaVersion)) return
  db.transaction(() => { db.exec(schema); db.pragma(`user_version = ${schemaVersion}`) }).immediate()
}
