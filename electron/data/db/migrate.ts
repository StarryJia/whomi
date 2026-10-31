import type { Store } from './open'
import { schema, schemaVersion, selfOptOutSchema, importStateSchema } from './schema'
import { aiSchema } from '../ai/schema'
import { migrateAiThreads } from '../ai/thread-migration'
export function migrateStore(store: Pick<Store, 'writer'>): void {
  const db = store.writer
  const version = db.pragma('user_version', { simple: true }) as bigint
  if (version > BigInt(schemaVersion)) throw new Error('请升级应用后打开资料库。')
  if (version === BigInt(schemaVersion)) return
  // 重建被问答引用的线程表时，事务提交前统一检查外键。
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      if (version < 1n) db.exec(schema)
      if (version < 2n) db.exec(selfOptOutSchema)
      if (version < 3n) db.exec(importStateSchema)
      if (version < 4n) db.exec(aiSchema)
      if (version < 5n) migrateAiThreads(db)
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('资料库迁移失败，请从备份恢复后重试。')
      db.pragma(`user_version = ${schemaVersion}`)
    }).immediate()
  } finally { db.pragma('foreign_keys = ON') }
}
