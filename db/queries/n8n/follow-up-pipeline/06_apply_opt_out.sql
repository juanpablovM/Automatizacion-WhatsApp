-- Compatibility wrapper for explicit opt-out. p1 conversation_id, p2 source_text, p3 source_message_id
WITH preference AS (
  INSERT INTO follow_up_preferences (conversation_id, opted_out, opted_out_at, source_text, source_message_id)
  VALUES ($1::bigint, TRUE, NOW(), NULLIF($2::text, ''), NULLIF($3::text, '')::bigint)
  ON CONFLICT (conversation_id) DO UPDATE SET opted_out = TRUE,
    opted_out_at = COALESCE(follow_up_preferences.opted_out_at, EXCLUDED.opted_out_at),
    source_text = EXCLUDED.source_text, source_message_id = EXCLUDED.source_message_id,
    updated_at = NOW() RETURNING conversation_id
), updated AS (
  -- An opt-out belongs to the contact, not to the thread they happened to be
  -- in when they asked. Reach every conversation this number holds on this
  -- source, so a new conversation cannot revive the cadence they refused.
  UPDATE follow_ups follow_up SET estado = 'opted_out', opted_out = TRUE,
    claim_token = NULL, claimed_at = NULL, next_retry_at = NULL, updated_at = NOW()
  WHERE follow_up.deleted_at IS NULL
    AND follow_up.estado IN ('pending', 'sending', 'error')
    AND EXISTS (
      SELECT 1
      FROM conversations source
      JOIN conversations candidate
        ON candidate.phone_number = source.phone_number
       AND candidate.source_number_id IS NOT DISTINCT FROM source.source_number_id
      WHERE source.id = $1::bigint
        AND candidate.id = follow_up.conversation_id
    )
  RETURNING follow_up.id
)
SELECT (SELECT COUNT(*) FROM updated) opted_out_count, TRUE opted_out_persisted, 'opted_out' result;
