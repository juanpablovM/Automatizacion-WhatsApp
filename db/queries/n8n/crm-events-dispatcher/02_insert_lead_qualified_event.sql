-- Enqueue one lead.qualified event (stage A, write side).
-- p1 lead_id, p2 revision, p3 event_id, p4 conversation_id, p5 body,
-- p6 requirement snapshot the body was built from, p7 blocked reason,
-- p8 record hash of the body (1.2), p9 source hash the candidate was selected
-- with (1.2). p8 and p9 are empty under 1.1.
--
-- The lead row is locked first. Under 1.1 (p9 empty) the event is inserted only
-- while the lead still holds the snapshot requirement and that requirement was
-- not enqueued yet. Under 1.2 (p9 set) the lead's inputs must still match the
-- source hash the body was built from; the event is inserted only when its
-- record hash differs from the last enqueued one, and either way the source
-- hash is recorded as examined, so an input change that leaves the record
-- unchanged (or a blocked lead) is not rebuilt on every pass. In both modes p2
-- must be exactly the next revision; otherwise a concurrent pass or a newer
-- correction got there first and this item does nothing (the next pass picks up
-- whatever is left). Unique event_id and (lead_id, event_type, revision) back
-- that up, so re-running the stage never duplicates an event.
WITH target AS MATERIALIZED (
  SELECT
    l.id,
    l.crm_enqueued_requirement,
    l.crm_enqueued_record_hash,
    COALESCE(l.requirement, '') AS current_requirement,
    CASE WHEN NULLIF($9::text, '') IS NOT NULL THEN crm_lead_source_hash(l.id) END AS current_source_hash
  FROM leads l
  WHERE l.id = $1::bigint
    AND l.deleted_at IS NULL
  FOR UPDATE
),
expected AS MATERIALIZED (
  SELECT t.id, t.crm_enqueued_record_hash
  FROM target t
  WHERE CASE
      WHEN NULLIF($9::text, '') IS NULL
        THEN t.current_requirement = $6::text
          AND t.crm_enqueued_requirement IS DISTINCT FROM t.current_requirement
      ELSE t.current_source_hash = $9::text
    END
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
    AND (NULLIF($9::text, '') IS NULL OR x.crm_enqueued_record_hash IS DISTINCT FROM NULLIF($8::text, ''))
  ON CONFLICT DO NOTHING
  RETURNING id, lead_id, event_id
),
lead_update AS (
  UPDATE leads l
  SET crm_enqueued_requirement = CASE WHEN i.id IS NOT NULL THEN $6::text ELSE l.crm_enqueued_requirement END,
      crm_enqueued_record_hash = CASE
        WHEN i.id IS NOT NULL AND NULLIF($9::text, '') IS NOT NULL THEN NULLIF($8::text, '')
        ELSE l.crm_enqueued_record_hash
      END,
      crm_checked_source_hash = COALESCE(NULLIF($9::text, ''), l.crm_checked_source_hash),
      crm_blocked_reason = CASE
        WHEN i.id IS NOT NULL THEN NULL
        WHEN NULLIF($7::text, '') IS NOT NULL THEN $7::text
        WHEN NULLIF($9::text, '') IS NOT NULL THEN NULL
        ELSE l.crm_blocked_reason
      END
  FROM expected x
  LEFT JOIN inserted i ON i.lead_id = x.id
  WHERE l.id = x.id
    AND (i.id IS NOT NULL OR NULLIF($7::text, '') IS NOT NULL OR NULLIF($9::text, '') IS NOT NULL)
  RETURNING l.id, l.crm_blocked_reason
)
SELECT
  $1::bigint AS lead_id,
  EXISTS (SELECT 1 FROM inserted) AS enqueued,
  (SELECT i.event_id FROM inserted i) AS event_id,
  (SELECT lu.crm_blocked_reason FROM lead_update lu) AS blocked_reason;
