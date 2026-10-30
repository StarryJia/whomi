import type { Database } from 'better-sqlite3'
import type { Store } from './open'

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

/**
 * 物理级联删除会话及其全部关联数据。
 */
export function purgeConversation(store: Store, conversationId: string): void {
  const id = BigInt(conversationId)
  const db = store.writer
  db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)
    if (!exists) return

    // 1. 清理 AI 线程与轮次用量（若表存在）
    if (tableExists(db, 'ai_threads')) {
      const thread = db.prepare('SELECT id FROM ai_threads WHERE conversation_id=?').get(id) as { id: bigint } | undefined
      if (thread) {
        if (tableExists(db, 'ai_turns')) {
          const turns = db.prepare('SELECT id FROM ai_turns WHERE thread_id=?').all(thread.id) as { id: bigint }[]
          for (const turn of turns) {
            if (tableExists(db, 'ai_request_usage')) {
              db.prepare("DELETE FROM ai_request_usage WHERE owner_kind='turn' AND owner_id=?").run(turn.id)
            }
          }
          db.prepare('DELETE FROM ai_turns WHERE thread_id=?').run(thread.id)
        }
        db.prepare('DELETE FROM ai_threads WHERE id=?').run(thread.id)
      }
    }

    // 2. 清理 AI 分析任务及报告、用量（若表存在）
    if (tableExists(db, 'ai_analysis_tasks')) {
      const tasks = db.prepare('SELECT id FROM ai_analysis_tasks WHERE conversation_id=?').all(id) as { id: bigint }[]
      for (const task of tasks) {
        if (tableExists(db, 'ai_analysis_batches')) {
          db.prepare('DELETE FROM ai_analysis_batches WHERE task_id=?').run(task.id)
        }
        if (tableExists(db, 'ai_analysis_coverage')) {
          db.prepare('DELETE FROM ai_analysis_coverage WHERE task_id=?').run(task.id)
        }
        if (tableExists(db, 'ai_reports')) {
          db.prepare('DELETE FROM ai_reports WHERE task_id=?').run(task.id)
        }
        if (tableExists(db, 'ai_request_usage')) {
          db.prepare("DELETE FROM ai_request_usage WHERE owner_kind='analysis' AND owner_id=?").run(task.id)
        }
      }
      db.prepare('DELETE FROM ai_analysis_tasks WHERE conversation_id=?').run(id)
    }
    if (tableExists(db, 'ai_preparations')) {
      db.prepare('DELETE FROM ai_preparations WHERE conversation_id=?').run(id)
    }

    // 回复可能指向同一会话的其他消息，须先清除整组引用再删除目标键。
    db.prepare('DELETE FROM message_replies WHERE conversation_id=?').run(id)
    db.prepare('DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(id)
    db.prepare('DELETE FROM message_origins WHERE conversation_id=?').run(id)
    db.prepare('DELETE FROM message_keys WHERE conversation_id=?').run(id)
    db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id)

    // 4. 本人确认与 opt-outs
    db.prepare('DELETE FROM self_confirmations WHERE conversation_id=?').run(id)
    db.prepare('DELETE FROM self_opt_outs WHERE conversation_id=?').run(id)

    // 5. 成员表
    db.prepare('DELETE FROM memberships WHERE conversation_id=?').run(id)

    // 6. 来源会话
    db.prepare('DELETE FROM source_conversations WHERE conversation_id=?').run(id)

    // 7. 清理 import_results
    db.prepare('DELETE FROM import_results WHERE conversation_id=?').run(id)

    // 8. 摘要
    db.prepare('DELETE FROM conversation_summaries WHERE conversation_id=?').run(id)

    // 9. 会话本体
    db.prepare('DELETE FROM conversations WHERE id=?').run(id)
  })()
}
