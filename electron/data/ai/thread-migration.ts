import type Database from 'better-sqlite3'
import { threadTitle } from './thread-title'

export function migrateAiThreads(db: Database.Database): void {
  const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='ai_threads'").get() as { seq: bigint } | undefined)?.seq ?? 0n
  db.exec(`CREATE TABLE ai_threads_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    title TEXT NOT NULL DEFAULT '新对话',
    created_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(created_at_ms>=0),
    updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(updated_at_ms>=0)
  ) STRICT;
  INSERT INTO ai_threads_next(id,conversation_id) SELECT id,conversation_id FROM ai_threads;
  DROP TABLE ai_threads;
  ALTER TABLE ai_threads_next RENAME TO ai_threads;
  CREATE INDEX ai_threads_conversation_updated ON ai_threads(conversation_id,updated_at_ms DESC,id DESC);`)
  db.prepare("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='ai_threads'").run(sequence)
  const rows = db.prepare('SELECT t.id,(SELECT prompt FROM ai_turns WHERE thread_id=t.id ORDER BY id LIMIT 1) AS prompt FROM ai_threads t').all() as { id: bigint; prompt: string | null }[]
  const update = db.prepare('UPDATE ai_threads SET title=? WHERE id=?')
  for (const row of rows) if (row.prompt) update.run(threadTitle(row.prompt), row.id)
}
