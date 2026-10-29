// m is the source membership; only a confirmed canonical account can link other memberships.
export const confirmedSelfSql = `EXISTS(
  SELECT 1 FROM self_confirmations s JOIN memberships confirmed ON confirmed.id=s.member_id AND confirmed.conversation_id=s.conversation_id
  WHERE s.conversation_id=m.conversation_id AND s.status='confirmed' AND s.source='user'
    AND (s.member_id=m.id OR (m.account_id IS NOT NULL AND confirmed.account_id=m.account_id))
) AND NOT EXISTS(SELECT 1 FROM self_opt_outs o WHERE o.conversation_id=m.conversation_id)`
