-- CRM 1.3 backfill dry run (scripts/ops/crm-backfill-1-3.sh, default mode).
-- Read-only: counts what crm_backfill_start (migration 059) and the
-- dispatcher's backfill stage (15/16) would enqueue, per event type.
-- psql variables: id_prefix, allowlist and test_phones (comma-separated
-- digits, '' = none), cutoff (ISO timestamp, '' = now), handoffs_enabled
-- ('true' or not). One row per item: (item, count); every item is listed,
-- also with 0. Items already enqueued under the prefix are not counted.
WITH params AS (
  SELECT
    :'id_prefix'::text AS id_prefix,
    string_to_array(NULLIF(regexp_replace(:'allowlist'::text, '[^0-9,]', '', 'g'), ''), ',') AS allow,
    string_to_array(NULLIF(regexp_replace(:'test_phones'::text, '[^0-9,]', '', 'g'), ''), ',') AS test,
    COALESCE(NULLIF(:'cutoff'::text, '')::timestamptz, NOW()) AS cutoff_at,
    :'handoffs_enabled'::text = 'true' AS handoffs
),
contacts AS MATERIALIZED (
  SELECT ct.id, ct.source_number_id, ct.phone_number,
         regexp_replace(ct.phone_number, '\D', '', 'g') = ANY (COALESCE(p.test, '{}')) AS is_test
  FROM crm_contacts ct
  CROSS JOIN params p
  WHERE p.allow IS NULL OR ct.phone_number = ANY (p.allow)
),
pending AS MATERIALIZED (
  SELECT c.* FROM contacts c WHERE NOT c.is_test
),
leads_out AS (
  SELECT o.outcome, (s.crm_user_id IS NULL) AS unmapped
  FROM pending pc
  CROSS JOIN params p
  JOIN leads l ON l.source_number_id = pc.source_number_id AND l.phone_number = pc.phone_number
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
  CROSS JOIN LATERAL crm_backfill_lead_outcome(
    l.clickup_status, l.clickup_status_at, l.created_at, crm_lead_last_activity_at(l.id), p.cutoff_at
  ) o
  WHERE l.deleted_at IS NULL AND l.created_at <= p.cutoff_at
    AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.lead_id = l.id AND e.event_type = 'lead.qualified' AND e.id_prefix = p.id_prefix)
),
handoffs_out AS (
  SELECT h.estado IN ('pending', 'notified', 'acknowledged') AS is_open
  FROM pending pc
  CROSS JOIN params p
  JOIN handoffs h ON h.phone_number = pc.phone_number
  LEFT JOIN conversations hc ON hc.id = h.conversation_id
  WHERE p.handoffs
    AND COALESCE(h.source_number_id, hc.source_number_id) = pc.source_number_id
    AND h.deleted_at IS NULL AND h.created_at <= p.cutoff_at
    AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.handoff_id = h.id AND e.event_type = 'handoff.created' AND e.id_prefix = p.id_prefix)
),
messages_out AS (
  SELECT m.id
  FROM pending pc
  CROSS JOIN params p
  JOIN conversations c ON c.source_number_id = pc.source_number_id AND c.phone_number = pc.phone_number AND c.deleted_at IS NULL
  JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
  WHERE m.created_at <= p.cutoff_at
    AND (m.direction = 'incoming' OR (m.direction = 'outgoing' AND m.delivery_status = 'sent'))
    AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.message_id = m.id AND e.event_type = 'message.new' AND e.id_prefix = p.id_prefix)
),
counts (sort, item, count) AS (
  SELECT 1, 'contacts_pending', (SELECT COUNT(*) FROM pending)
  UNION ALL SELECT 2, 'contacts_skipped_test_phone', (SELECT COUNT(*) FROM contacts WHERE is_test)
  UNION ALL SELECT 3, 'contact.upserted', (SELECT COUNT(*) FROM pending)
  UNION ALL SELECT 4, 'lead.qualified:won', (SELECT COUNT(*) FROM leads_out WHERE outcome = 'won')
  UNION ALL SELECT 5, 'lead.qualified:lost', (SELECT COUNT(*) FROM leads_out WHERE outcome = 'lost')
  UNION ALL SELECT 6, 'lead.qualified:open', (SELECT COUNT(*) FROM leads_out WHERE outcome = 'open')
  UNION ALL SELECT 7, 'lead.qualified:blocked_seller_not_mapped', (SELECT COUNT(*) FROM leads_out WHERE unmapped)
  UNION ALL SELECT 8, 'handoff.created:resolved', (SELECT COUNT(*) FROM handoffs_out WHERE NOT is_open)
  UNION ALL SELECT 9, 'handoff.created:open', (SELECT COUNT(*) FROM handoffs_out WHERE is_open)
  UNION ALL SELECT 10, 'message.new', (SELECT COUNT(*) FROM messages_out)
  UNION ALL SELECT 11, 'ownership.taken', (
    SELECT COUNT(*) FROM pending pc WHERE inbound_contact_seller_owned(pc.source_number_id, pc.phone_number)
  )
  UNION ALL SELECT 12, 'contact.state', (SELECT COUNT(*) FROM pending)
)
SELECT item, count FROM counts ORDER BY sort;
