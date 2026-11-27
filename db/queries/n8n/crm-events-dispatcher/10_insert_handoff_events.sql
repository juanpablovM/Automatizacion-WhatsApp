-- Enqueue handoff.created events (stage E, write side; 1.2d).
-- p1 JSON array of { handoff_id, revision, event_id, conversation_id, body,
-- blocked_reason, crm_opportunity_id, crm_seller_id } built by Build Handoff
-- Events (the last two are the routing key the body carries).
--
-- Each handoff row is locked first. A row is enqueued only while the handoff
-- is still live, its stored routing is the one the body carries, and the
-- revision is exactly the next one: the first event, or the one after an event
-- parked by 422 invalid_seller. Otherwise a concurrent pass got there first and
-- the row does nothing. Unique event_id and (handoff_id, revision) back that
-- up. An enqueued event clears the handoff's crm_blocked_reason; a blocked row
-- records its reason there, so the next pass retries it last. A 1.3 body's root
-- contact_id is stored in crm_events.contact_id (NULL for 1.2 bodies).
WITH input AS MATERIALIZED (
  SELECT x.handoff_id, x.revision, x.event_id, x.conversation_id, x.body,
         NULLIF(x.blocked_reason, '') AS blocked_reason,
         lower(NULLIF(x.crm_opportunity_id, '')) AS crm_opportunity_id,
         lower(NULLIF(x.crm_seller_id, '')) AS crm_seller_id
  FROM jsonb_to_recordset(COALESCE(NULLIF($1::text, ''), '[]')::jsonb)
    AS x(handoff_id BIGINT, revision INTEGER, event_id TEXT, conversation_id TEXT, body TEXT,
         blocked_reason TEXT, crm_opportunity_id TEXT, crm_seller_id TEXT)
),
target AS MATERIALIZED (
  SELECT i.*, h.crm_opportunity_id::text AS stored_opportunity_id, s.crm_user_id::text AS stored_seller_id
  FROM input i
  JOIN handoffs h ON h.id = i.handoff_id AND h.deleted_at IS NULL
  LEFT JOIN sellers s ON s.id = h.crm_routing_seller_id
  ORDER BY i.handoff_id
  FOR UPDATE OF h
),
expected AS MATERIALIZED (
  SELECT t.*
  FROM target t
  WHERE t.stored_opportunity_id IS NOT DISTINCT FROM t.crm_opportunity_id
    AND t.stored_seller_id IS NOT DISTINCT FROM t.crm_seller_id
    AND (
      SELECT COALESCE(MAX(e.revision), 0)
      FROM crm_events e
      WHERE e.handoff_id = t.handoff_id
        AND e.event_type = 'handoff.created'
    ) = t.revision - 1
    AND COALESCE((
      SELECT e.status = 'parked' AND e.last_error = 'http_422:invalid_seller'
      FROM crm_events e
      WHERE e.handoff_id = t.handoff_id
        AND e.event_type = 'handoff.created'
      ORDER BY e.revision DESC
      LIMIT 1
    ), TRUE)
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body, contact_id)
  SELECT x.event_id, 'handoff.created', x.conversation_id, x.handoff_id, x.revision, x.body,
         substring(x.body::jsonb ->> 'contact_id' FROM '-contact-([0-9]+)$')::bigint
  FROM expected x
  WHERE x.blocked_reason IS NULL
    AND NULLIF(x.body, '') IS NOT NULL
    AND NULLIF(x.event_id, '') IS NOT NULL
    AND NULLIF(x.conversation_id, '') IS NOT NULL
  ORDER BY x.handoff_id
  ON CONFLICT DO NOTHING
  RETURNING handoff_id
),
unblocked AS (
  UPDATE handoffs h
  SET crm_blocked_reason = NULL
  FROM inserted i
  WHERE h.id = i.handoff_id
    AND h.crm_blocked_reason IS NOT NULL
  RETURNING h.id
),
blocked AS (
  UPDATE handoffs h
  SET crm_blocked_reason = t.blocked_reason
  FROM target t
  WHERE h.id = t.handoff_id
    AND t.blocked_reason IS NOT NULL
    AND h.crm_blocked_reason IS DISTINCT FROM t.blocked_reason
  RETURNING h.id
)
SELECT
  (SELECT COUNT(*) FROM inserted)::integer AS enqueued,
  (SELECT COUNT(*) FROM blocked)::integer AS blocked,
  (SELECT COUNT(*) FROM unblocked)::integer AS unblocked;
