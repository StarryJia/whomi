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
      if (version < 6n) {
        for (const table of ['conversations', 'ai_threads']) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));
            ALTER TABLE ${table} ADD COLUMN list_rank INTEGER NOT NULL DEFAULT 0;`)
        }
        db.exec('CREATE INDEX conversations_list_order ON conversations(pinned DESC,list_rank,id DESC); CREATE INDEX threads_list_order ON ai_threads(conversation_id,pinned DESC,list_rank,updated_at_ms DESC,id DESC)')
      }
      if (version < 7n) {
        db.exec(`ALTER TABLE ai_analysis_tasks ADD COLUMN created_at_ms INTEGER;
          ALTER TABLE ai_analysis_tasks ADD COLUMN completed_at_ms INTEGER;
          ALTER TABLE ai_analysis_tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));
          ALTER TABLE ai_analysis_tasks ADD COLUMN list_rank INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE ai_analysis_tasks ADD COLUMN thinking_level TEXT;
          ALTER TABLE ai_turns ADD COLUMN thinking_level TEXT;
          CREATE INDEX analysis_list_order ON ai_analysis_tasks(conversation_id,pinned DESC,list_rank,id DESC);`)
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('资料库迁移失败，请从备份恢复后重试。')
      db.pragma(`user_version = ${schemaVersion}`)
    }).immediate()
  } finally { db.pragma('foreign_keys = ON') }
}
