-- Enqueue message.new events (stage C, write side).
-- p1 JSON array of { message_id, event_id, conversation_id, body,
-- blocked_reason } built by Build Message Events.
--
-- A row with a body and no blocked reason becomes a pending crm_events row
-- (lead_id NULL, revision 1) and clears any earlier block of that message. A
-- blocked row is recorded in crm_message_blocks instead, so the next pass sees
-- it last and retries it. Unique event_id and (message_id, event_type) make a
-- re-run or a concurrent pass a no-op, never a duplicate.
WITH input AS MATERIALIZED (
  SELECT x.message_id, x.event_id, x.conversation_id, x.body, NULLIF(x.blocked_reason, '') AS blocked_reason
  FROM jsonb_to_recordset(COALESCE(NULLIF($1::text, ''), '[]')::jsonb)
    AS x(message_id BIGINT, event_id TEXT, conversation_id TEXT, body TEXT, blocked_reason TEXT)
  JOIN messages m ON m.id = x.message_id
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, conversation_id, message_id, revision, body)
  SELECT i.event_id, 'message.new', i.conversation_id, i.message_id, 1, i.body
  FROM input i
  WHERE i.blocked_reason IS NULL
    AND NULLIF(i.body, '') IS NOT NULL
    AND NULLIF(i.event_id, '') IS NOT NULL
    AND NULLIF(i.conversation_id, '') IS NOT NULL
  ORDER BY i.message_id
  ON CONFLICT DO NOTHING
  RETURNING message_id
),
unblocked AS (
  DELETE FROM crm_message_blocks b
  USING inserted i
  WHERE b.message_id = i.message_id
  RETURNING b.message_id
),
blocked AS (
  INSERT INTO crm_message_blocks (message_id, reason)
  SELECT i.message_id, i.blocked_reason
  FROM input i
  WHERE i.blocked_reason IS NOT NULL
  ON CONFLICT (message_id) DO UPDATE
  SET reason = EXCLUDED.reason,
      updated_at = NOW()
  WHERE crm_message_blocks.reason IS DISTINCT FROM EXCLUDED.reason
  RETURNING message_id
)
SELECT
  (SELECT COUNT(*) FROM inserted)::integer AS enqueued,
  (SELECT COUNT(*) FROM blocked)::integer AS blocked,
  (SELECT COUNT(*) FROM unblocked)::integer AS unblocked;
