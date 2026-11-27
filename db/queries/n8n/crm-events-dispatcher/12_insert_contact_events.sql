-- Enqueue contact.upserted events (stage F, write side; revision 1.3).
-- p1 JSON array of { contact_id, revision, event_id, body, blocked_reason }
-- built by Build Contact Events.
--
-- Each contact row is locked first. A row is enqueued only while its revision
-- is exactly the next one under the event's id prefix and its data (phone,
-- name) differs from the newest contact.upserted under that prefix; otherwise
-- a concurrent pass got there first or nothing changed, and the row does
-- nothing. The unique (contact_id, event_type, revision, id_prefix) from
-- migration 054 backs that up. The event has no conversation_id. An enqueued
-- event clears the contact's crm_blocked_reason (migration 055); a blocked row
-- records its reason there, so the next pass retries it last.
WITH input AS MATERIALIZED (
  SELECT x.contact_id, x.revision, x.event_id, x.body, NULLIF(x.blocked_reason, '') AS blocked_reason
  FROM jsonb_to_recordset(COALESCE(NULLIF($1::text, ''), '[]')::jsonb)
    AS x(contact_id BIGINT, revision INTEGER, event_id TEXT, body TEXT, blocked_reason TEXT)
),
target AS MATERIALIZED (
  SELECT i.*, crm_event_id_prefix(COALESCE(i.event_id, '')) AS id_prefix
  FROM input i
  JOIN crm_contacts ct ON ct.id = i.contact_id
  ORDER BY i.contact_id
  FOR UPDATE OF ct
),
expected AS MATERIALIZED (
  SELECT t.*
  FROM target t
  LEFT JOIN LATERAL (
    SELECT e.revision, e.body
    FROM crm_events e
    WHERE e.contact_id = t.contact_id
      AND e.event_type = 'contact.upserted'
      AND e.id_prefix = t.id_prefix
    ORDER BY e.revision DESC
    LIMIT 1
  ) last_event ON TRUE
  WHERE t.blocked_reason IS NULL
    AND NULLIF(t.body, '') IS NOT NULL
    AND NULLIF(t.event_id, '') IS NOT NULL
    AND COALESCE(last_event.revision, 0) = t.revision - 1
    AND (
      last_event.body IS NULL
      OR ((last_event.body::jsonb -> 'data') - 'revision') IS DISTINCT FROM ((t.body::jsonb -> 'data') - 'revision')
    )
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, contact_id, revision, body)
  SELECT x.event_id, 'contact.upserted', x.contact_id, x.revision, x.body
  FROM expected x
  ORDER BY x.contact_id
  ON CONFLICT DO NOTHING
  RETURNING contact_id
),
unblocked AS (
  UPDATE crm_contacts ct
  SET crm_blocked_reason = NULL
  FROM inserted i
  WHERE ct.id = i.contact_id
    AND ct.crm_blocked_reason IS NOT NULL
  RETURNING ct.id
),
blocked AS (
  UPDATE crm_contacts ct
  SET crm_blocked_reason = t.blocked_reason
  FROM target t
  WHERE ct.id = t.contact_id
    AND t.blocked_reason IS NOT NULL
    AND ct.crm_blocked_reason IS DISTINCT FROM t.blocked_reason
  RETURNING ct.id
)
SELECT
  (SELECT COUNT(*) FROM inserted)::integer AS enqueued,
  (SELECT COUNT(*) FROM blocked)::integer AS blocked,
  (SELECT COUNT(*) FROM unblocked)::integer AS unblocked;
