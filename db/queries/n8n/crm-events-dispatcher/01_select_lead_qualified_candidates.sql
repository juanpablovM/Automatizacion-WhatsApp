-- Select leads to announce to the CRM as lead.qualified (stage A, read side).
-- p1 CRM_EVENTS_SINCE (ISO timestamp), p2 batch size.
--
-- A lead qualifies once it has an assigned seller, was created at or after
-- CRM_EVENTS_SINCE (historic leads are never backfilled), and its requirement
-- differs from the one its newest enqueued event carried: the first time, or
-- after a customer correction. A seller without crm_user_id blocks the lead as
-- seller_not_mapped; mapping the seller makes it a candidate on the next pass.
-- `revision` is only a proposal: Insert Lead Qualified Event re-checks it under
-- a row lock, so concurrent passes can never enqueue the same revision twice.
WITH scope AS MATERIALIZED (
  SELECT l.id, s.crm_user_id
  FROM leads l
  JOIN sellers s ON s.id = l.assigned_seller_id
  WHERE l.deleted_at IS NULL
    AND l.created_at >= $1::timestamptz
    AND l.crm_enqueued_requirement IS DISTINCT FROM COALESCE(l.requirement, '')
),
blocked AS (
  UPDATE leads l
  SET crm_blocked_reason = 'seller_not_mapped'
  FROM scope sc
  WHERE l.id = sc.id
    AND sc.crm_user_id IS NULL
    AND l.crm_blocked_reason IS DISTINCT FROM 'seller_not_mapped'
  RETURNING l.id
)
SELECT
  l.id AS lead_id,
  (
    SELECT COALESCE(MAX(e.revision), 0) + 1
    FROM crm_events e
    WHERE e.lead_id = l.id
      AND e.event_type = 'lead.qualified'
  ) AS revision,
  COALESCE(
    l.source_conversation_id,
    (
      SELECT c.id
      FROM conversations c
      WHERE c.lead_id = l.id
        AND c.deleted_at IS NULL
      ORDER BY c.id DESC
      LIMIT 1
    )
  ) AS conversation_id,
  l.phone_number,
  l.whatsapp_name,
  l.service,
  l.city,
  l.requirement,
  l.qualification_context,
  sc.crm_user_id::text AS crm_user_id
FROM scope sc
JOIN leads l ON l.id = sc.id
WHERE sc.crm_user_id IS NOT NULL
-- Previously blocked leads (e.g. an invalid phone) go last so they cannot
-- starve fresh leads out of the batch.
ORDER BY (l.crm_blocked_reason IS NOT NULL), l.created_at, l.id
LIMIT COALESCE(NULLIF($2::text, '')::integer, 20);
