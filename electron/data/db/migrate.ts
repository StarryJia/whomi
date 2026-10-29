import type { Store } from './open'
import { schema, schemaVersion, selfOptOutSchema } from './schema'
export function migrateStore(store: Pick<Store, 'writer'>): void {
  const db = store.writer
  const version = db.pragma('user_version', { simple: true }) as bigint
  if (version > BigInt(schemaVersion)) throw new Error('请升级应用后打开资料库。')
  if (version === BigInt(schemaVersion)) return
  db.transaction(() => {
    if (version < 1n) db.exec(schema)
    if (version < 2n) db.exec(selfOptOutSchema)
    db.pragma(`user_version = ${schemaVersion}`)
  }).immediate()
}
