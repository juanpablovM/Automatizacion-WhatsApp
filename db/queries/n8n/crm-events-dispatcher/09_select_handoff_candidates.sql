-- Select and route handoffs to announce to the CRM as handoff.created (stage
-- E, read side; 1.2d). Protocol revision 1.2 or 1.3 with CRM_EVENTS_HANDOFFS_ENABLED
-- only: otherwise p1 is not 'true' and it returns no row and routes nothing.
-- p1 handoffs enabled ('true'), p2 CRM_EVENTS_SINCE (ISO timestamp), p3 batch
-- size, p4 CRM_EVENTS_PHONE_ALLOWLIST (comma-separated digits, '' = no
-- filter), p5 test phones (LEAD_TEST_PHONE_NUMBERS as digits), p6 test seller
-- id (LEAD_TEST_SELLER_ID, '' when unset).
--
-- A handoff is a candidate while it is live, open (pending, notified or
-- acknowledged), created at or after CRM_EVENTS_SINCE, within the allowlist
-- (the same rule as leads), and either has no handoff.created event yet or
-- its newest one was parked by 422 invalid_seller (the CRM stored nothing, so
-- the next event, revision + 1 with the same handoff_id, goes to another
-- seller). crm_route_handoff (migration 045) routes each candidate once, in
-- creation order, and stores the routing on the handoff; a candidate it cannot
-- route (no eligible seller left) returns no row and stays blocked. Blocked
-- handoffs go last so they cannot starve the batch. `revision` is only a
-- proposal: Insert Handoff Events re-checks it under a row lock.
-- Rows already locked by a concurrent pass are skipped.
-- Every row also carries the handoff's contact (crm_contact_ref) and the id
-- prefixes holding its contact.upserted; under 1.3 Build Handoff Events drops a
-- handoff whose contact was not upserted under the current prefix yet
-- (ordering rule). Its routing is already stored, so the next pass reuses it.
-- Under 1.2 the builder ignores both columns.
WITH scope AS MATERIALIZED (
  SELECT
    h.id,
    CASE
      WHEN NULLIF($6::text, '') IS NOT NULL
        AND regexp_replace(h.phone_number, '\D', '', 'g') = ANY (string_to_array(NULLIF($5::text, ''), ','))
        THEN NULLIF($6::text, '')::bigint
    END AS test_seller_id
  FROM handoffs h
  WHERE $1::text = 'true'
    AND h.deleted_at IS NULL
    AND h.created_at >= $2::timestamptz
    AND h.estado IN ('pending', 'notified', 'acknowledged')
    AND ($4::text = '' OR h.phone_number = ANY (string_to_array($4::text, ',')))
    AND COALESCE((
      SELECT e.status = 'parked' AND e.last_error = 'http_422:invalid_seller'
      FROM crm_events e
      WHERE e.handoff_id = h.id
        AND e.event_type = 'handoff.created'
      ORDER BY e.revision DESC
      LIMIT 1
    ), TRUE)
  ORDER BY (h.crm_blocked_reason IS NOT NULL), h.created_at, h.id
  LIMIT COALESCE(NULLIF($3::text, '')::integer, 20)
  FOR UPDATE OF h SKIP LOCKED
),
routed AS MATERIALIZED (
  SELECT sc.id, r.crm_opportunity_id, r.crm_routing_seller_id
  FROM scope sc
  CROSS JOIN LATERAL crm_route_handoff(sc.id, sc.test_seller_id) r
)
SELECT
  h.id AS handoff_id,
  (
    SELECT COALESCE(MAX(e.revision), 0) + 1
    FROM crm_events e
    WHERE e.handoff_id = h.id
      AND e.event_type = 'handoff.created'
  ) AS revision,
  h.conversation_id,
  h.area,
  h.motivo,
  h.escalation_reason,
  h.prioridad,
  h.phone_number,
  ro.crm_opportunity_id::text AS crm_opportunity_id,
  CASE WHEN ro.crm_opportunity_id IS NULL THEN s.crm_user_id::text END AS crm_seller_id,
  -- The customer's name when the bot knows it: the conversation's lead, else
  -- the newest live lead of the phone.
  COALESCE(
    (
      SELECT NULLIF(btrim(l.whatsapp_name), '')
      FROM conversations c
      JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
      WHERE c.id = h.conversation_id
    ),
    (
      SELECT NULLIF(btrim(l.whatsapp_name), '')
      FROM leads l
      WHERE l.phone_number = h.phone_number
        AND l.deleted_at IS NULL
        AND NULLIF(btrim(l.whatsapp_name), '') IS NOT NULL
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1
    )
  ) AS customer_name,
  -- The last text the customer wrote before the handoff. Fixed at creation, so
  -- a retry after 422 invalid_seller carries the same description.
  (
    SELECT m.text_body
    FROM messages m
    WHERE m.conversation_id = h.conversation_id
      AND m.direction = 'incoming'
      AND m.deleted_at IS NULL
      AND NULLIF(btrim(m.text_body), '') IS NOT NULL
      AND m.created_at <= h.created_at
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) AS last_customer_message,
  ct.contact_id,
  (
    SELECT string_agg(DISTINCT e.id_prefix, ',')
    FROM crm_events e
    WHERE e.contact_id = ct.contact_id
      AND e.event_type = 'contact.upserted'
  ) AS contact_upserted_prefixes
FROM routed ro
JOIN handoffs h ON h.id = ro.id
-- crm_contact_ensure: a handoff whose contact row is missing (a skipped
-- contact trigger) gets it here, so it is delayed at most one pass, never lost.
CROSS JOIN LATERAL (SELECT crm_contact_ensure(h.source_number_id, h.phone_number) AS contact_id) ct
LEFT JOIN sellers s ON s.id = ro.crm_routing_seller_id
ORDER BY h.created_at, h.id;
