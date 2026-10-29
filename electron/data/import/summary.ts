import type { Store } from '../db/open'
import type { LocalId } from '../../../src/shared/conversation-model'
export async function rebuildSummary(store: Store, conversationId: LocalId): Promise<void> {
  store.writer.prepare(`INSERT INTO conversation_summaries(conversation_id,message_count,member_count,first_sent_at_ms,last_sent_at_ms,status,updated_at_ms)
    SELECT c.id,(SELECT count(*) FROM messages WHERE conversation_id=c.id),(SELECT count(*) FROM memberships WHERE conversation_id=c.id),
    (SELECT min(sent_at_ms) FROM messages WHERE conversation_id=c.id),(SELECT max(sent_at_ms) FROM messages WHERE conversation_id=c.id),'ready',?
    FROM conversations c WHERE c.id=? ON CONFLICT(conversation_id) DO UPDATE SET message_count=excluded.message_count,member_count=excluded.member_count,first_sent_at_ms=excluded.first_sent_at_ms,last_sent_at_ms=excluded.last_sent_at_ms,status='ready',updated_at_ms=excluded.updated_at_ms`).run(Date.now(),BigInt(conversationId))
}
