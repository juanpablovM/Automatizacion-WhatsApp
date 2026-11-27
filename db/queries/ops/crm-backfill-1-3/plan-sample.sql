-- CRM 1.3 backfill dry run, per contact (scripts/ops/crm-backfill-1-3.sh):
-- the first :sample_size pending contacts (largest history first) with what
-- each would get. Read-only; same psql variables as plan.sql, plus
-- sample_size. Phones are masked to their last 4 digits.
WITH params AS (
  SELECT
    :'id_prefix'::text AS id_prefix,
    string_to_array(NULLIF(regexp_replace(:'allowlist'::text, '[^0-9,]', '', 'g'), ''), ',') AS allow,
    string_to_array(NULLIF(regexp_replace(:'test_phones'::text, '[^0-9,]', '', 'g'), ''), ',') AS test,
    COALESCE(NULLIF(:'cutoff'::text, '')::timestamptz, NOW()) AS cutoff_at
),
pending AS MATERIALIZED (
  SELECT ct.id, ct.source_number_id, ct.phone_number
  FROM crm_contacts ct
  CROSS JOIN params p
  WHERE (p.allow IS NULL OR ct.phone_number = ANY (p.allow))
    AND NOT (regexp_replace(ct.phone_number, '\D', '', 'g') = ANY (COALESCE(p.test, '{}')))
)
SELECT
  pc.id AS contact_id,
  '…' || right(pc.phone_number, 4) AS phone,
  (SELECT COUNT(*) FROM leads l CROSS JOIN params p
   WHERE l.source_number_id = pc.source_number_id AND l.phone_number = pc.phone_number
     AND l.deleted_at IS NULL AND l.created_at <= p.cutoff_at) AS leads,
  (SELECT string_agg(o.outcome, ',' ORDER BY l.created_at) FROM leads l CROSS JOIN params p
   CROSS JOIN LATERAL crm_backfill_lead_outcome(l.clickup_status, l.clickup_status_at, l.created_at,
                                                crm_lead_last_activity_at(l.id), p.cutoff_at) o
   WHERE l.source_number_id = pc.source_number_id AND l.phone_number = pc.phone_number
     AND l.deleted_at IS NULL AND l.created_at <= p.cutoff_at) AS outcomes,
  (SELECT COUNT(*) FROM handoffs h CROSS JOIN params p
   WHERE h.source_number_id = pc.source_number_id AND h.phone_number = pc.phone_number
     AND h.deleted_at IS NULL AND h.created_at <= p.cutoff_at) AS handoffs,
  (SELECT COUNT(*) FROM conversations c JOIN messages m ON m.conversation_id = c.id CROSS JOIN params p
   WHERE c.source_number_id = pc.source_number_id AND c.phone_number = pc.phone_number
     AND c.deleted_at IS NULL AND m.deleted_at IS NULL AND m.created_at <= p.cutoff_at
     AND (m.direction = 'incoming' OR (m.direction = 'outgoing' AND m.delivery_status = 'sent'))) AS messages,
  inbound_contact_seller_owned(pc.source_number_id, pc.phone_number) AS seller_held
FROM pending pc
ORDER BY messages DESC, pc.id
LIMIT NULLIF(:'sample_size'::text, '')::integer;
