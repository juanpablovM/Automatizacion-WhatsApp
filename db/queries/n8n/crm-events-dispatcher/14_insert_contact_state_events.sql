-- Enqueue contact.state events (stage G, write side; revision 1.3).
-- p1 JSON array of { contact_id, id_prefix, input_hash, state_version,
-- event_id, body, blocked_reason } built by Build Contact State Events.
--
-- Each contact row is locked first (as Insert Contact Events does). A row is
-- enqueued only while its state_version is exactly the next one under its id
-- prefix and its data (state, progress, stage, conversation_id; not
-- state_version or changed_at) differs from the newest contact.state under
-- that prefix; otherwise a concurrent pass got there first or nothing really
-- changed, and nothing is enqueued. The unique (contact_id, event_type,
-- revision, id_prefix) from migration 054 backs that up. The event has no
-- conversation_id column value (the episode is inside data).
-- crm_contact_state_marks (migration 057) then records the check: the input
-- hash once the row is settled (enqueued, or the same data is already the
-- newest), else NULL so the next pass checks it again; a blocked row records
-- its reason (the select puts it last) and clears it once it builds.
WITH input AS MATERIALIZED (
  SELECT DISTINCT ON (x.contact_id)
    x.contact_id,
    NULLIF(x.id_prefix, '') AS id_prefix,
    NULLIF(x.input_hash, '') AS input_hash,
    x.state_version,
    NULLIF(x.event_id, '') AS event_id,
    NULLIF(x.body, '') AS body,
    NULLIF(x.blocked_reason, '') AS blocked_reason
  FROM jsonb_to_recordset(COALESCE(NULLIF($1::text, ''), '[]')::jsonb)
    AS x(contact_id BIGINT, id_prefix TEXT, input_hash TEXT, state_version INTEGER, event_id TEXT, body TEXT, blocked_reason TEXT)
  ORDER BY x.contact_id
),
target AS MATERIALIZED (
  SELECT i.*
  FROM input i
  JOIN crm_contacts ct ON ct.id = i.contact_id
  WHERE i.id_prefix IS NOT NULL
    AND (i.event_id IS NULL OR crm_event_id_prefix(i.event_id) = i.id_prefix)
  ORDER BY i.contact_id
  FOR UPDATE OF ct
),
classified AS MATERIALIZED (
  SELECT
    t.*,
    last_event.revision AS last_revision,
    (last_event.body IS NOT NULL AND t.body IS NOT NULL
      AND ((last_event.body::jsonb -> 'data') - 'state_version' - 'changed_at')
        = ((t.body::jsonb -> 'data') - 'state_version' - 'changed_at')) AS unchanged
  FROM target t
  LEFT JOIN LATERAL (
    SELECT e.revision, e.body
    FROM crm_events e
    WHERE e.contact_id = t.contact_id
      AND e.event_type = 'contact.state'
      AND e.id_prefix = t.id_prefix
    ORDER BY e.revision DESC
    LIMIT 1
  ) last_event ON TRUE
),
expected AS MATERIALIZED (
  SELECT c.*
  FROM classified c
  WHERE c.blocked_reason IS NULL
    AND c.body IS NOT NULL
    AND c.event_id IS NOT NULL
    AND COALESCE(c.last_revision, 0) = c.state_version - 1
    AND NOT c.unchanged
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, contact_id, revision, body)
  SELECT x.event_id, 'contact.state', x.contact_id, x.state_version, x.body
  FROM expected x
  ORDER BY x.contact_id
  ON CONFLICT DO NOTHING
  RETURNING contact_id
),
marked AS (
  INSERT INTO crm_contact_state_marks (contact_id, id_prefix, input_hash, blocked_reason, checked_at)
  SELECT
    c.contact_id,
    c.id_prefix,
    CASE
      WHEN c.blocked_reason IS NULL
        AND (c.unchanged OR EXISTS (SELECT 1 FROM inserted i WHERE i.contact_id = c.contact_id))
      THEN c.input_hash
    END,
    c.blocked_reason,
    NOW()
  FROM classified c
  ORDER BY c.contact_id
  ON CONFLICT (contact_id, id_prefix) DO UPDATE
  SET input_hash = EXCLUDED.input_hash,
      blocked_reason = EXCLUDED.blocked_reason,
      checked_at = EXCLUDED.checked_at
  RETURNING contact_id, blocked_reason
)
SELECT
  (SELECT COUNT(*) FROM inserted)::integer AS enqueued,
  (SELECT COUNT(*) FROM marked WHERE blocked_reason IS NOT NULL)::integer AS blocked;
