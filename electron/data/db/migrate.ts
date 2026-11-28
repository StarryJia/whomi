import type { Store } from './open'
import { schema, schemaVersion, selfOptOutSchema, importStateSchema, messageKindSchema } from './schema'
import { aiSchema, insightSchema } from '../ai/schema'
import { migrateAiThreads } from '../ai/thread-migration'
import { hasWechatRecallMarker } from '../parsers/wechat-recall'
export function migrateStore(store: Pick<Store, 'writer'>): void {
  const db = store.writer
  const version = db.pragma('user_version', { simple: true }) as bigint
  if (version > BigInt(schemaVersion)) throw new Error('请升级应用后打开资料库。')
  if (version === BigInt(schemaVersion)) return
  // 重建被其他表引用的数据表时，事务提交前统一检查外键。
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
      if (version < 8n) db.exec(`ALTER TABLE ai_analysis_tasks ADD COLUMN prompt_snapshot TEXT CHECK(prompt_snapshot IS NULL OR json_valid(prompt_snapshot));
        ALTER TABLE ai_turns ADD COLUMN system_prompt TEXT;`)
      if (version < 9n) db.exec(insightSchema)
      if (version < 10n) db.exec(messageKindSchema)
      if (version < 11n) db.exec(`ALTER TABLE ai_insight_snapshots ADD COLUMN source_text_bytes INTEGER CHECK(source_text_bytes >= 0);
        ALTER TABLE ai_model_versions ADD COLUMN change_source TEXT NOT NULL DEFAULT 'settings' CHECK(change_source IN ('settings','catalog','account'));
        ALTER TABLE ai_analysis_tasks ADD COLUMN processing_snapshot TEXT CHECK(processing_snapshot IS NULL OR json_valid(processing_snapshot));`)
      if (version < 12n) {
        // 冻结任务的修订号含原始发送者与类型；只在恢复旧任务或核对旧引用时使用这些字段。
        db.exec(`CREATE TABLE legacy_insight_source_classification (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          member_id INTEGER, sender_kind TEXT NOT NULL, sender_name TEXT NOT NULL, kind TEXT NOT NULL
        ) STRICT;
        CREATE INDEX legacy_insight_source_member ON legacy_insight_source_classification(member_id);
        CREATE VIEW visible_memberships AS SELECT m.* FROM memberships m
          WHERE NOT EXISTS (SELECT 1 FROM legacy_insight_source_classification l WHERE l.member_id=m.id)
          OR EXISTS (SELECT 1 FROM messages x WHERE x.member_id=m.id AND x.conversation_id=m.conversation_id)
          OR EXISTS (SELECT 1 FROM self_confirmations s WHERE s.member_id=m.id AND s.source='user');`)
      }
      if (version < 14n) {
        db.function('whomi_is_recall', { deterministic: true }, (label, localType, content) => Number(hasWechatRecallMarker(label, localType, content)))
        db.exec(`INSERT INTO legacy_insight_source_classification SELECT m.id,m.member_id,m.sender_kind,m.sender_name,m.kind
          FROM messages m WHERE m.kind!='system'
          AND (m.source_type IN ('撤回消息','消息撤回') OR m.text LIKE '%撤回了一条消息%')
          AND whomi_is_recall(m.source_type,json_extract(m.extra,'$.localType'),m.text)
          AND NOT EXISTS (SELECT 1 FROM message_replies r WHERE r.message_id=m.id AND
            (r.target_message_id IS NOT NULL OR r.original_id IS NOT NULL OR r.text IS NOT NULL OR r.sender_name IS NOT NULL OR r.sent_at_ms IS NOT NULL))
          AND EXISTS (SELECT 1 FROM message_origins o WHERE o.message_id=m.id AND o.parser_id IN ('echotrace','weflow'));
        UPDATE messages SET member_id=NULL,sender_kind='system',sender_name='',kind='system',extra=json_remove(extra,'$.selfHint')
          WHERE kind!='system' AND id IN (SELECT message_id FROM legacy_insight_source_classification);
        UPDATE conversation_summaries SET member_count=(SELECT count(*) FROM visible_memberships m WHERE m.conversation_id=conversation_summaries.conversation_id)
          WHERE conversation_id IN (SELECT x.conversation_id FROM messages x JOIN legacy_insight_source_classification l ON l.message_id=x.id);`)
      }
      if (version < 15n) db.exec(`ALTER TABLE ai_analysis_tasks ADD COLUMN failure_operation_id TEXT;
        ALTER TABLE ai_analysis_tasks ADD COLUMN failure_at_ms INTEGER CHECK(failure_at_ms >= 0);`)
      if (version < 16n) db.exec(`ALTER TABLE ai_analysis_tasks ADD COLUMN methodology_snapshot TEXT CHECK(methodology_snapshot IS NULL OR json_valid(methodology_snapshot));
        ALTER TABLE ai_turns ADD COLUMN methodology_snapshot TEXT CHECK(methodology_snapshot IS NULL OR json_valid(methodology_snapshot));`)
      if (version < 17n) db.exec(`ALTER TABLE ai_request_usage ADD COLUMN model_id TEXT;
        ALTER TABLE ai_request_usage ADD COLUMN model_version INTEGER;
        ALTER TABLE ai_analysis_tasks ADD COLUMN model_history TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(model_history) AND json_type(model_history)='array');
        UPDATE ai_request_usage SET (model_id,model_version)=(SELECT model_id,model_version FROM ai_analysis_tasks t WHERE t.id=owner_id) WHERE owner_kind='analysis';
        UPDATE ai_request_usage SET (model_id,model_version)=(SELECT model_id,model_version FROM ai_turns t WHERE t.id=owner_id) WHERE owner_kind='turn';`)
      if (version < 18n) db.exec(`CREATE TABLE ai_insight_evidence_cards (
        task_id INTEGER NOT NULL REFERENCES ai_analysis_tasks(id) ON DELETE CASCADE,
        segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        start_time_ms INTEGER,
        end_time_ms INTEGER,
        data TEXT NOT NULL CHECK(json_valid(data)),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(task_id, segment_index)
      ) STRICT;`)
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('资料库迁移失败，请从备份恢复后重试。')
      db.pragma(`user_version = ${schemaVersion}`)
    }).immediate()
  } finally { db.pragma('foreign_keys = ON') }
}
