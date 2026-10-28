export const schemaVersion = 1
export const schema = `
CREATE TABLE conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('direct','group','unknown')),
 created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE source_conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL REFERENCES conversations(id),
 platform TEXT NOT NULL,
 owner_key TEXT,
 conversation_key TEXT,
 namespace TEXT NOT NULL,
 UNIQUE(platform,owner_key,conversation_key,namespace),
 UNIQUE(id,conversation_id)
) STRICT;
CREATE INDEX source_conversations_conversation ON source_conversations(conversation_id);
CREATE TABLE accounts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 platform TEXT NOT NULL,
 stable_account_key TEXT NOT NULL,
 UNIQUE(platform,stable_account_key)
) STRICT;
CREATE TABLE memberships (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL REFERENCES conversations(id),
 source_conversation_id INTEGER NOT NULL,
 source_key TEXT NOT NULL,
 display_name TEXT NOT NULL,
 account_id INTEGER REFERENCES accounts(id),
 self_hint INTEGER CHECK(self_hint IN (0,1)),
 UNIQUE(source_conversation_id,source_key),
 UNIQUE(id,conversation_id),
 FOREIGN KEY(source_conversation_id,conversation_id) REFERENCES source_conversations(id,conversation_id)
) STRICT;
CREATE INDEX memberships_conversation ON memberships(conversation_id);
CREATE INDEX memberships_account ON memberships(account_id);
CREATE TABLE self_confirmations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL REFERENCES conversations(id),
 member_id INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('candidate','confirmed','rejected','revoked')),
 source TEXT NOT NULL CHECK(source IN ('parser','user')),
 CHECK(status!='confirmed' OR source='user'),
 FOREIGN KEY(member_id,conversation_id) REFERENCES memberships(id,conversation_id)
) STRICT;
CREATE UNIQUE INDEX one_confirmed_self ON self_confirmations(conversation_id) WHERE status='confirmed';
CREATE INDEX self_confirmations_member ON self_confirmations(member_id,conversation_id);
CREATE TABLE account_aliases (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 platform TEXT NOT NULL,
 alias_key TEXT NOT NULL,
 account_id INTEGER NOT NULL REFERENCES accounts(id),
 source TEXT NOT NULL CHECK(source='user'),
 UNIQUE(platform,alias_key)
) STRICT;
CREATE INDEX account_aliases_account ON account_aliases(account_id);
CREATE TABLE import_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
 created_at_ms INTEGER NOT NULL,
 completed_at_ms INTEGER,
 error_code TEXT,
 error_action TEXT
) STRICT;
CREATE TABLE import_results (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 job_id INTEGER NOT NULL REFERENCES import_jobs(id),
 candidate_id TEXT NOT NULL,
 conversation_id INTEGER REFERENCES conversations(id),
 status TEXT NOT NULL CHECK(status IN ('pending','running','committed','failed','cancelled')),
 added_count INTEGER NOT NULL DEFAULT 0 CHECK(added_count>=0),
 skipped_count INTEGER NOT NULL DEFAULT 0 CHECK(skipped_count>=0),
 issue_count INTEGER NOT NULL DEFAULT 0 CHECK(issue_count>=0),
 committed_at_ms INTEGER,
 error_code TEXT,
 error_action TEXT,
 UNIQUE(job_id,candidate_id),
 UNIQUE(id,conversation_id),
 CHECK(status!='committed' OR (committed_at_ms IS NOT NULL AND conversation_id IS NOT NULL))
) STRICT;
CREATE INDEX import_results_conversation ON import_results(conversation_id);
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL REFERENCES conversations(id),
 member_id INTEGER,
 sender_kind TEXT NOT NULL CHECK(sender_kind IN ('member','system','unknown')),
 sender_name TEXT NOT NULL,
 sent_at_ms INTEGER CHECK(sent_at_ms BETWEEN -9007199254740991 AND 9007199254740991),
 time_raw TEXT,
 time_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(time_precision IN ('millisecond','second','minute','unknown')),
 timezone TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('text','image','audio','video','file','sticker','link','location','reply','forward','system','unknown')),
 text TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 source_type TEXT,
 extra TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extra) AND json_type(extra)='object'),
 time_bucket INTEGER GENERATED ALWAYS AS (CASE WHEN sent_at_ms IS NULL THEN 1 ELSE 0 END) STORED,
 sort_time INTEGER GENERATED ALWAYS AS (coalesce(sent_at_ms,0)) STORED,
 UNIQUE(id,conversation_id),
 FOREIGN KEY(member_id,conversation_id) REFERENCES memberships(id,conversation_id),
 CHECK((sender_kind='member' AND member_id IS NOT NULL) OR (sender_kind!='member' AND member_id IS NULL))
) STRICT;
CREATE INDEX messages_read_order ON messages(conversation_id,time_bucket,sort_time,id);
CREATE INDEX messages_member ON messages(member_id,conversation_id);
CREATE TABLE message_keys (
 conversation_id INTEGER NOT NULL,
 id_namespace TEXT NOT NULL CHECK(length(id_namespace)>0),
 original_id TEXT NOT NULL CHECK(length(original_id)>0),
 message_id INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,id_namespace,original_id),
 FOREIGN KEY(message_id,conversation_id) REFERENCES messages(id,conversation_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX message_keys_target ON message_keys(conversation_id,id_namespace,original_id,message_id);
CREATE INDEX message_keys_message ON message_keys(message_id,conversation_id);
CREATE TABLE message_origins (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id INTEGER NOT NULL,
 conversation_id INTEGER NOT NULL,
 import_result_id INTEGER NOT NULL,
 file_fingerprint TEXT NOT NULL,
 source_conversation_key TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 parser_id TEXT NOT NULL,
 parser_version TEXT NOT NULL,
 UNIQUE(conversation_id,file_fingerprint,source_conversation_key,ordinal),
 FOREIGN KEY(message_id,conversation_id) REFERENCES messages(id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(import_result_id,conversation_id) REFERENCES import_results(id,conversation_id)
) STRICT;
CREATE INDEX message_origins_message ON message_origins(message_id,conversation_id);
CREATE INDEX message_origins_result ON message_origins(import_result_id,conversation_id);
CREATE TABLE message_replies (
 message_id INTEGER PRIMARY KEY,
 conversation_id INTEGER NOT NULL,
 target_message_id INTEGER,
 original_id TEXT,
 id_namespace TEXT,
 text TEXT,
 sender_name TEXT,
 sent_at_ms INTEGER CHECK(sent_at_ms BETWEEN -9007199254740991 AND 9007199254740991),
 state TEXT NOT NULL DEFAULT 'unresolved' CHECK(state IN ('unresolved','resolved')),
 FOREIGN KEY(message_id,conversation_id) REFERENCES messages(id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(target_message_id,conversation_id) REFERENCES messages(id,conversation_id),
 FOREIGN KEY(conversation_id,id_namespace,original_id,target_message_id) REFERENCES message_keys(conversation_id,id_namespace,original_id,message_id),
 CHECK((state='resolved' AND target_message_id IS NOT NULL AND original_id IS NOT NULL AND id_namespace IS NOT NULL) OR (state='unresolved' AND target_message_id IS NULL))
) STRICT;
CREATE INDEX message_replies_target ON message_replies(target_message_id,conversation_id);
CREATE INDEX message_replies_key ON message_replies(conversation_id,id_namespace,original_id);
CREATE TABLE message_attachments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('text','image','audio','video','file','sticker','link','location','reply','forward','system','unknown')),
 locator TEXT,
 name TEXT,
 state TEXT NOT NULL CHECK(state IN ('unresolved','missing'))
) STRICT;
CREATE INDEX message_attachments_message ON message_attachments(message_id);
CREATE TABLE conversation_summaries (
 conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
 message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count>=0),
 member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count>=0),
 first_sent_at_ms INTEGER,
 last_sent_at_ms INTEGER,
 status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
 updated_at_ms INTEGER
) STRICT;
`


