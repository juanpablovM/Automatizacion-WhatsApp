-- Enqueue ownership.taken / ownership.released events (stage D, write side).
-- p1 JSON array of { change_id, event_id, conversation_id, event_type, body,
-- blocked_reason } built by Build Ownership Events.
--
-- A row with a body and no blocked reason becomes a pending crm_events row
-- (lead_id NULL, revision 1, ownership_change_id set) and clears any earlier
-- block of that change. A blocked row records its reason on the change, so the
-- next pass sees it last and retries it. Unique event_id and
-- ownership_change_id make a re-run or a concurrent pass a no-op.
WITH input AS MATERIALIZED (
  SELECT x.change_id, x.event_id, x.conversation_id, x.event_type, x.body, NULLIF(x.blocked_reason, '') AS blocked_reason
  FROM jsonb_to_recordset(COALESCE(NULLIF($1::text, ''), '[]')::jsonb)
    AS x(change_id BIGINT, event_id TEXT, conversation_id TEXT, event_type TEXT, body TEXT, blocked_reason TEXT)
  JOIN crm_ownership_changes ch ON ch.id = x.change_id
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, conversation_id, ownership_change_id, revision, body)
  SELECT i.event_id, i.event_type, i.conversation_id, i.change_id, 1, i.body
  FROM input i
  WHERE i.blocked_reason IS NULL
    AND i.event_type IN ('ownership.taken', 'ownership.released')
    AND NULLIF(i.body, '') IS NOT NULL
    AND NULLIF(i.event_id, '') IS NOT NULL
    AND NULLIF(i.conversation_id, '') IS NOT NULL
  ORDER BY i.change_id
  ON CONFLICT DO NOTHING
  RETURNING ownership_change_id
),
unblocked AS (
  UPDATE crm_ownership_changes ch
  SET crm_blocked_reason = NULL
  FROM inserted i
  WHERE ch.id = i.ownership_change_id
    AND ch.crm_blocked_reason IS NOT NULL
  RETURNING ch.id
),
blocked AS (
  UPDATE crm_ownership_changes ch
  SET crm_blocked_reason = i.blocked_reason
  FROM input i
  WHERE ch.id = i.change_id
    AND i.blocked_reason IS NOT NULL
    AND ch.crm_blocked_reason IS DISTINCT FROM i.blocked_reason
  RETURNING ch.id
)
SELECT
  (SELECT COUNT(*) FROM inserted)::integer AS enqueued,
  (SELECT COUNT(*) FROM blocked)::integer AS blocked,
  (SELECT COUNT(*) FROM unblocked)::integer AS unblocked;
