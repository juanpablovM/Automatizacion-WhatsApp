-- Compatibility wrapper for explicit opt-out. $1 conversation_id, $2 source_text, $3 source_message_id
WITH preference AS (
  INSERT INTO follow_up_preferences (conversation_id, opted_out, opted_out_at, source_text, source_message_id)
  VALUES ($1::bigint, TRUE, NOW(), NULLIF($2::text, ''), NULLIF($3::text, '')::bigint)
  ON CONFLICT (conversation_id) DO UPDATE SET opted_out = TRUE,
    opted_out_at = COALESCE(follow_up_preferences.opted_out_at, EXCLUDED.opted_out_at),
    source_text = EXCLUDED.source_text, source_message_id = EXCLUDED.source_message_id,
    updated_at = NOW() RETURNING conversation_id
), updated AS (
  UPDATE follow_ups SET estado = 'opted_out', opted_out = TRUE,
    claim_token = NULL, claimed_at = NULL, next_retry_at = NULL, updated_at = NOW()
  WHERE conversation_id = $1::bigint AND deleted_at IS NULL
    AND estado IN ('pending', 'sending', 'error') RETURNING id
)
SELECT (SELECT COUNT(*) FROM updated) opted_out_count, TRUE opted_out_persisted, 'opted_out' result;
