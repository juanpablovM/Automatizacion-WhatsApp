-- Enqueue one lead.qualified event (stage A, write side).
-- p1 lead_id, p2 revision, p3 event_id, p4 conversation_id, p5 body,
-- p6 requirement snapshot the body was built from, p7 blocked reason.
--
-- The lead row is locked first. The event is inserted only while the lead
-- still holds the snapshot requirement, that requirement was not enqueued yet,
-- and p2 is exactly the next revision; otherwise a concurrent pass or a newer
-- correction got there first and this item does nothing (the next pass picks
-- up whatever is left). Unique event_id and (lead_id, event_type, revision)
-- back that up, so re-running the stage never duplicates an event.
WITH target AS MATERIALIZED (
  SELECT l.id, l.crm_enqueued_requirement, COALESCE(l.requirement, '') AS current_requirement
  FROM leads l
  WHERE l.id = $1::bigint
    AND l.deleted_at IS NULL
  FOR UPDATE
),
expected AS MATERIALIZED (
  SELECT t.id
  FROM target t
  WHERE t.current_requirement = $6::text
    AND t.crm_enqueued_requirement IS DISTINCT FROM t.current_requirement
    AND (
      SELECT COALESCE(MAX(e.revision), 0)
      FROM crm_events e
      WHERE e.lead_id = t.id
        AND e.event_type = 'lead.qualified'
    ) = $2::integer - 1
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body)
  SELECT $3::text, 'lead.qualified', $4::text, x.id, $2::integer, $5::text
  FROM expected x
  WHERE NULLIF($7::text, '') IS NULL
  ON CONFLICT DO NOTHING
  RETURNING id, lead_id, event_id
),
lead_update AS (
  UPDATE leads l
  SET crm_enqueued_requirement = CASE WHEN i.id IS NOT NULL THEN $6::text ELSE l.crm_enqueued_requirement END,
      crm_blocked_reason = CASE WHEN i.id IS NOT NULL THEN NULL ELSE NULLIF($7::text, '') END
  FROM expected x
  LEFT JOIN inserted i ON i.lead_id = x.id
  WHERE l.id = x.id
    AND (i.id IS NOT NULL OR NULLIF($7::text, '') IS NOT NULL)
  RETURNING l.id, l.crm_blocked_reason
)
SELECT
  $1::bigint AS lead_id,
  EXISTS (SELECT 1 FROM inserted) AS enqueued,
  (SELECT i.event_id FROM inserted i) AS event_id,
  (SELECT lu.crm_blocked_reason FROM lead_update lu) AS blocked_reason;
