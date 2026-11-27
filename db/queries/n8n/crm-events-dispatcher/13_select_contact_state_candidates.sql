-- Select contacts whose contact.state must be checked (stage G, read side).
-- Protocol revision 1.3 only: under any other revision it returns no row.
-- p1 protocol revision, p2 CRM_EVENTS_SINCE (ISO timestamp), p3 id prefix,
-- p4 CRM_EVENTS_PHONE_ALLOWLIST (comma-separated digits, '' = no filter),
-- p5 batch size.
--
-- contact.state is a polled snapshot (feature U5, S4): its inputs change
-- through many writers and seller leases expire by time, so every pass
-- recomputes, per contact, from its latest live conversation (started_at,
-- then id), in this priority:
--   seller_held     inbound_contact_seller_owned() (migration 047) is true;
--   handed_off      the customer has an open handoff (pending, notified,
--                   acknowledged) whose handoff.created was delivered under p3,
--                   so the CRM already has it;
--   ready_to_quote  the latest conversation is handed_to_sales;
--   qualifying      it is active, waiting_user or out_of_flow;
--   idle            anything else, or no live conversation.
-- progress and stage are built in JavaScript (Build Contact State Events) from
-- the latest conversation's qualification_context and pending_question_key,
-- with the catalog products that list two or more variants (the only catalog
-- data that changes which required question is answered). input_hash covers
-- all of that; a contact is returned only while it differs from the hash its
-- last settled check stored in crm_contact_state_marks (migration 057) under
-- p3, so an unchanged contact costs nothing and the batch is not starved.
-- state_version is only a proposal (the newest contact.state under p3 + 1):
-- Insert Contact State Events re-checks it under a row lock and enqueues only
-- when (state, progress, stage, conversation_id) really changed.
--
-- Scope: the contact has a contact.upserted under p3 (ordering rule of 1.3),
-- its phone is in the allowlist when one is set, and it has activity at or
-- after CRM_EVENTS_SINCE (the rule of Select Contact Candidates) or already a
-- contact.state under p3 (so a known customer keeps getting its state, for
-- example idle once its only conversation is gone). Blocked contacts go last.
-- 1.3 backfill (migration 059, U8): a contact whose backfill under p3 is
-- pending gets no state yet (the state is the last event of its backfill);
-- once completed it is in scope whatever its activity.
WITH catalog AS MATERIALIZED (
  SELECT entries, md5(entries::text) AS catalog_hash
  FROM (
    SELECT COALESCE(jsonb_agg(product.entry ORDER BY product.entry->>'ref'), '[]'::jsonb) AS entries
    FROM (
      SELECT jsonb_build_object(
               'ref', 'product:' || COALESCE(NULLIF(ci.sku, ''), ci.id::text),
               'concept', 'product',
               'value', ci.name,
               'technical_sheet', jsonb_build_object('variants', (
                 SELECT COALESCE(jsonb_agg(jsonb_build_object('name', variant.value->'name') ORDER BY variant.ordinality), '[]'::jsonb)
                 FROM jsonb_array_elements(ci.metadata->'technical_sheet'->'variants') WITH ORDINALITY AS variant(value, ordinality)
                 WHERE jsonb_typeof(variant.value) = 'object'
               ))
             ) AS entry
      FROM catalog_items ci
      WHERE $1::text = '1.3'
        AND ci.is_active AND ci.deleted_at IS NULL AND NULLIF(ci.name, '') IS NOT NULL
        AND ci.item_type IS DISTINCT FROM 'service'
        AND jsonb_typeof(ci.metadata->'technical_sheet'->'variants') = 'array'
        AND jsonb_array_length(ci.metadata->'technical_sheet'->'variants') >= 2
    ) product
  ) aggregated
),
scope AS MATERIALIZED (
  SELECT ct.id, ct.source_number_id, ct.phone_number
  FROM crm_contacts ct
  WHERE $1::text = '1.3'
    AND ($4::text = '' OR ct.phone_number = ANY (string_to_array($4::text, ',')))
    AND EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.contact_id = ct.id AND e.event_type = 'contact.upserted' AND e.id_prefix = $3::text
    )
    AND NOT crm_contact_backfill_pending(ct.id, $3::text)
    AND (
      EXISTS (
        SELECT 1 FROM crm_events e
        WHERE e.contact_id = ct.id AND e.event_type = 'contact.state' AND e.id_prefix = $3::text
      )
      OR EXISTS (
        SELECT 1 FROM crm_contact_backfills b
        WHERE b.contact_id = ct.id AND b.id_prefix = $3::text AND b.status = 'completed'
      )
      OR EXISTS (
        SELECT 1 FROM leads l
        WHERE l.source_number_id = ct.source_number_id AND l.phone_number = ct.phone_number
          AND l.deleted_at IS NULL AND l.created_at >= $2::timestamptz
      )
      OR EXISTS (
        SELECT 1 FROM handoffs h
        WHERE h.source_number_id = ct.source_number_id AND h.phone_number = ct.phone_number
          AND h.deleted_at IS NULL AND h.created_at >= $2::timestamptz
      )
      OR EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.source_number_id = ct.source_number_id AND c.phone_number = ct.phone_number
          AND c.deleted_at IS NULL AND c.created_at >= $2::timestamptz
      )
      OR EXISTS (
        SELECT 1
        FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        WHERE c.source_number_id = ct.source_number_id AND c.phone_number = ct.phone_number
          AND c.deleted_at IS NULL AND m.deleted_at IS NULL AND m.created_at >= $2::timestamptz
      )
    )
),
snapshot AS MATERIALIZED (
  SELECT
    sc.id,
    sc.phone_number,
    latest.id AS conversation_id,
    latest.status_code,
    latest.pending_question_key,
    latest.qualification_context,
    CASE
      WHEN inbound_contact_seller_owned(sc.source_number_id, sc.phone_number) THEN 'seller_held'
      WHEN EXISTS (
        SELECT 1
        FROM handoffs h
        WHERE h.source_number_id = sc.source_number_id AND h.phone_number = sc.phone_number
          AND h.deleted_at IS NULL
          AND h.estado IN ('pending', 'notified', 'acknowledged')
          AND EXISTS (
            SELECT 1 FROM crm_events e
            WHERE e.handoff_id = h.id
              AND e.event_type = 'handoff.created'
              AND e.status = 'delivered'
              AND e.id_prefix = $3::text
          )
      ) THEN 'handed_off'
      WHEN latest.status_code = 'handed_to_sales' THEN 'ready_to_quote'
      WHEN latest.status_code IN ('active', 'waiting_user', 'out_of_flow') THEN 'qualifying'
      ELSE 'idle'
    END AS state
  FROM scope sc
  LEFT JOIN LATERAL (
    SELECT c.id, cs.code AS status_code, c.pending_question_key, c.qualification_context
    FROM conversations c
    JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
    WHERE c.source_number_id = sc.source_number_id AND c.phone_number = sc.phone_number
      AND c.deleted_at IS NULL
    ORDER BY c.started_at DESC, c.id DESC
    LIMIT 1
  ) latest ON TRUE
),
hashed AS MATERIALIZED (
  SELECT
    s.*,
    md5(jsonb_build_array(
      s.state, s.conversation_id, s.status_code, s.pending_question_key, s.qualification_context, cat.catalog_hash
    )::text) AS input_hash
  FROM snapshot s
  CROSS JOIN catalog cat
)
SELECT
  h.id AS contact_id,
  h.phone_number,
  h.state,
  COALESCE(last_event.revision, 0) + 1 AS state_version,
  h.conversation_id,
  h.status_code AS latest_status_code,
  h.pending_question_key,
  h.qualification_context,
  cat.entries AS catalog,
  h.input_hash,
  to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at
FROM hashed h
CROSS JOIN catalog cat
LEFT JOIN crm_contact_state_marks mark ON mark.contact_id = h.id AND mark.id_prefix = $3::text
LEFT JOIN LATERAL (
  SELECT e.revision
  FROM crm_events e
  WHERE e.contact_id = h.id
    AND e.event_type = 'contact.state'
    AND e.id_prefix = $3::text
  ORDER BY e.revision DESC
  LIMIT 1
) last_event ON TRUE
WHERE mark.input_hash IS DISTINCT FROM h.input_hash
   OR last_event.revision IS NULL
ORDER BY (mark.blocked_reason IS NOT NULL), h.id
LIMIT COALESCE(NULLIF($5::text, '')::integer, 100);
