-- Select leads to announce to the CRM as lead.qualified (stage A, read side).
-- p1 CRM_EVENTS_SINCE (ISO timestamp), p2 batch size, p3 protocol revision,
-- p4 CRM_EVENTS_PHONE_ALLOWLIST (comma-separated digits, '' = no filter).
--
-- A lead qualifies once it has an assigned seller and was created at or after
-- CRM_EVENTS_SINCE (historic leads are never backfilled). Under 1.1 it is a
-- candidate while its requirement differs from the one its newest enqueued
-- event carried. Under 1.2 it is a candidate while the fingerprint of its raw
-- record inputs (crm_lead_source_hash) differs from the one last examined; the
-- builder then decides whether the record it would send actually changed. A
-- seller without crm_user_id blocks the lead as seller_not_mapped; mapping the
-- seller makes it a candidate on the next pass. `revision` is only a proposal:
-- Insert Lead Qualified Event re-checks it under a row lock, so concurrent
-- passes can never enqueue the same revision twice.
-- A non-empty allowlist restricts the scope to leads with one of those phones
-- (e.g. test phones against the CRM dev environment); other leads are neither
-- selected nor marked blocked. Messages and ownership changes follow, since
-- they are only sent for conversations of a delivered lead.qualified.
-- Revision 1.3 behaves exactly like 1.2 and also returns the lead's contact
-- (crm_contact_ref, migration 053) and the id prefixes that already hold a
-- contact.upserted of that contact: Build Lead Qualified Events drops a lead
-- whose contact was not upserted under the current prefix yet (ordering rule),
-- and the lead stays a candidate for the next pass.
-- Under 1.3 it also returns the opportunity the CRM linked to the customer
-- (contact.opportunity_linked, migration 058) while that link is open, unless
-- the lead already carries another opportunity: the lead.qualified then
-- carries that crm_opportunity_id.
-- 1.3 backfill (migration 059, U8): a lead whose contact's backfill is still
-- pending lists no prefix in contact_upserted_prefixes, so the builder drops
-- it until the backfill completed (its history goes first). A lead the
-- backfill sent as historical won/lost is never a candidate again: a later
-- live lead.qualified would turn it into an opportunity.
WITH scope AS MATERIALIZED (
  SELECT l.id, s.crm_user_id,
         CASE WHEN $3::text IN ('1.2', '1.3') THEN crm_lead_source_hash(l.id) END AS source_hash
  FROM leads l
  JOIN sellers s ON s.id = l.assigned_seller_id
  WHERE l.deleted_at IS NULL
    AND l.created_at >= $1::timestamptz
    AND ($4::text = '' OR l.phone_number = ANY(string_to_array($4::text, ',')))
    AND NOT (
      $3::text = '1.3'
      AND EXISTS (
        SELECT 1 FROM crm_events e
        WHERE e.lead_id = l.id
          AND e.event_type = 'lead.qualified'
          AND (e.body::jsonb #>> '{data,outcome}') IN ('won', 'lost')
      )
    )
    AND CASE
      WHEN $3::text IN ('1.2', '1.3') THEN crm_lead_source_hash(l.id) IS DISTINCT FROM l.crm_checked_source_hash
      ELSE l.crm_enqueued_requirement IS DISTINCT FROM COALESCE(l.requirement, '')
    END
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
  sc.crm_user_id::text AS crm_user_id,
  sc.source_hash AS crm_source_hash,
  wn.phone_number AS source_number_phone,
  -- The newest advisor decision of the lead (same lookup as the ClickUp
  -- task). Only read under 1.2 and 1.3, where it becomes ai_summary.
  CASE WHEN $3::text IN ('1.2', '1.3') THEN (
    SELECT ad.output_payload
    FROM advisor_decisions ad
    LEFT JOIN conversations c_ad ON c_ad.id = ad.conversation_id
    WHERE ad.lead_id = l.id
       OR c_ad.lead_id = l.id
    ORDER BY ad.created_at DESC, ad.id DESC
    LIMIT 1
  ) END AS advisor_output_payload,
  ct.contact_id,
  CASE WHEN $3::text = '1.3' THEN (
    SELECT string_agg(DISTINCT e.id_prefix, ',')
    FROM crm_events e
    WHERE e.contact_id = ct.contact_id
      AND e.event_type = 'contact.upserted'
      AND NOT crm_contact_backfill_pending(ct.contact_id, e.id_prefix)
  ) END AS contact_upserted_prefixes,
  CASE WHEN $3::text = '1.3' AND (l.crm_opportunity_id IS NULL OR l.crm_opportunity_id = lk.crm_opportunity_id)
    THEN lk.crm_opportunity_id::text END AS crm_linked_opportunity_id
FROM scope sc
JOIN leads l ON l.id = sc.id
LEFT JOIN whatsapp_numbers wn ON wn.id = l.source_number_id
CROSS JOIN LATERAL (SELECT CASE WHEN $3::text = '1.3'
  THEN crm_contact_ensure(l.source_number_id, l.phone_number)
  ELSE crm_contact_ref(l.source_number_id, l.phone_number) END AS contact_id) ct
LEFT JOIN LATERAL (
  SELECT ol.crm_opportunity_id FROM crm_contact_open_link(ct.contact_id) ol WHERE $3::text = '1.3'
) lk ON TRUE
WHERE sc.crm_user_id IS NOT NULL
-- Previously blocked leads (e.g. an invalid phone) go last so they cannot
-- starve fresh leads out of the batch.
ORDER BY (l.crm_blocked_reason IS NOT NULL), l.created_at, l.id
LIMIT COALESCE(NULLIF($2::text, '')::integer, 20);
