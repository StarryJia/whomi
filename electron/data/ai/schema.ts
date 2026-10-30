import { ANALYSIS_PROMPT_VERSION } from './prompt-version'

export const aiSchema = `
CREATE TABLE ai_models (
 id TEXT PRIMARY KEY,
 version INTEGER NOT NULL CHECK(version>0),
 data TEXT NOT NULL CHECK(json_valid(data)),
 encrypted_key TEXT
) STRICT;
CREATE TABLE ai_model_versions (
 model_id TEXT NOT NULL REFERENCES ai_models(id),
 version INTEGER NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 encrypted_key TEXT,
 PRIMARY KEY(model_id,version)
) STRICT;
CREATE TABLE ai_skills (
 id TEXT PRIMARY KEY,
 data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
CREATE TABLE ai_preparations (
 token TEXT PRIMARY KEY,
 conversation_id INTEGER NOT NULL REFERENCES conversations(id),
 data TEXT NOT NULL CHECK(json_valid(data)),
 self_fingerprint TEXT NOT NULL,
 model_version INTEGER NOT NULL,
 prompt_version TEXT NOT NULL DEFAULT '${ANALYSIS_PROMPT_VERSION}',
 expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE ai_analysis_tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL REFERENCES conversations(id),
 request_id TEXT NOT NULL UNIQUE,
 preparation_token TEXT NOT NULL UNIQUE REFERENCES ai_preparations(token),
 model_id TEXT NOT NULL REFERENCES ai_models(id),
 model_version INTEGER NOT NULL,
 prompt_version TEXT NOT NULL DEFAULT '${ANALYSIS_PROMPT_VERSION}',
 self_fingerprint TEXT NOT NULL,
 snapshot_max_id INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','summarizing','completed','stopped','failed','interrupted')),
 total_messages INTEGER NOT NULL CHECK(total_messages>=0),
 skipped_messages INTEGER NOT NULL CHECK(skipped_messages>=0),
 event_sequence INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 checkpoint TEXT
) STRICT;
CREATE UNIQUE INDEX ai_one_active_analysis ON ai_analysis_tasks(conversation_id) WHERE state IN ('queued','running','summarizing');
CREATE TABLE ai_analysis_batches (
 task_id INTEGER NOT NULL REFERENCES ai_analysis_tasks(id),
 batch_index INTEGER NOT NULL CHECK(batch_index>=0),
 data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(task_id,batch_index)
) STRICT;
CREATE TABLE ai_analysis_coverage (
 task_id INTEGER NOT NULL REFERENCES ai_analysis_tasks(id),
 message_id INTEGER NOT NULL REFERENCES messages(id),
 PRIMARY KEY(task_id,message_id)
) STRICT;
CREATE TABLE ai_reports (
 task_id INTEGER PRIMARY KEY REFERENCES ai_analysis_tasks(id),
 data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
CREATE TABLE ai_threads (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id)
) STRICT;
CREATE TABLE ai_turns (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 thread_id INTEGER NOT NULL REFERENCES ai_threads(id),
 request_id TEXT NOT NULL,
 prompt TEXT NOT NULL,
 reference_ids TEXT NOT NULL CHECK(json_valid(reference_ids)),
 model_id TEXT NOT NULL REFERENCES ai_models(id),
 model_version INTEGER NOT NULL,
 skill TEXT CHECK(skill IS NULL OR json_valid(skill)),
 self_fingerprint TEXT NOT NULL,
 text TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('queued','running','summarizing','completed','stopped','failed','interrupted')),
 attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt>0),
 event_sequence INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 checkpoint TEXT,
 UNIQUE(thread_id,request_id)
) STRICT;
CREATE UNIQUE INDEX ai_one_active_turn ON ai_turns(thread_id) WHERE state IN ('queued','running','summarizing');
CREATE TABLE ai_request_usage (
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('analysis','turn')),
 owner_id INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(owner_kind,owner_id,request_id)
) STRICT;
`
