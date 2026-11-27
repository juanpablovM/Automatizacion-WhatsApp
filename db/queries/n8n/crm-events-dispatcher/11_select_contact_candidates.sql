-- Select contacts to announce to the CRM as contact.upserted (stage F, read
-- side). Protocol revision 1.3 only: under any other revision it returns no
-- row. p1 protocol revision, p2 CRM_EVENTS_SINCE (ISO timestamp), p3 id
-- prefix, p4 CRM_EVENTS_PHONE_ALLOWLIST (comma-separated digits, '' = no
-- filter), p5 batch size.
--
-- A contact (crm_contacts, migration 053) is in scope when it has activity at
-- or after CRM_EVENTS_SINCE (a lead, handoff or conversation created, or a
-- message received or sent, since then) and, with a non-empty allowlist, its
-- phone is listed (the same rule as leads). It is a candidate while it has no
-- contact.upserted under p3 yet, or the phone or name its newest one under p3
-- carried differs from the current ones. name is the newest live lead's
-- whatsapp_name, else the WhatsApp profile name (pushName) of the newest
-- incoming message of the contact; NULL when neither exists. `revision` is
-- only a proposal: Insert Contact Events re-checks it under a row lock and
-- inserts only when the built data really changed (this select approximates
-- the builder's trimming and 200-character cut).
-- Ordering rule (1.3): the other stages send a contact's events only once it
-- has a contact.upserted under p3, so this stage runs first in the pass.
-- Blocked contacts go last so they cannot starve the batch.
WITH scope AS MATERIALIZED (
  SELECT ct.id, ct.source_number_id, ct.phone_number, ct.crm_blocked_reason
  FROM crm_contacts ct
  WHERE $1::text = '1.3'
    AND ($4::text = '' OR ct.phone_number = ANY (string_to_array($4::text, ',')))
    AND (
      EXISTS (
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
current_values AS MATERIALIZED (
  SELECT
    sc.id,
    sc.phone_number,
    sc.crm_blocked_reason,
    COALESCE(lead_name.name, profile.name) AS name,
    last_event.revision AS last_revision,
    last_event.body AS last_body
  FROM scope sc
  LEFT JOIN LATERAL (
    SELECT NULLIF(regexp_replace(l.whatsapp_name, '^\s+|\s+$', '', 'g'), '') AS name
    FROM leads l
    WHERE l.source_number_id = sc.source_number_id AND l.phone_number = sc.phone_number
      AND l.deleted_at IS NULL
      AND NULLIF(regexp_replace(l.whatsapp_name, '^\s+|\s+$', '', 'g'), '') IS NOT NULL
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 1
  ) lead_name ON TRUE
  LEFT JOIN LATERAL (
    SELECT NULLIF(regexp_replace(m.raw_payload #>> '{data,pushName}', '^\s+|\s+$', '', 'g'), '') AS name
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE c.source_number_id = sc.source_number_id AND c.phone_number = sc.phone_number
      AND c.deleted_at IS NULL AND m.deleted_at IS NULL
      AND m.direction = 'incoming'
      AND NULLIF(regexp_replace(m.raw_payload #>> '{data,pushName}', '^\s+|\s+$', '', 'g'), '') IS NOT NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) profile ON TRUE
  LEFT JOIN LATERAL (
    SELECT e.revision, e.body
    FROM crm_events e
    WHERE e.contact_id = sc.id
      AND e.event_type = 'contact.upserted'
      AND e.id_prefix = $3::text
    ORDER BY e.revision DESC
    LIMIT 1
  ) last_event ON TRUE
)
SELECT
  cv.id AS contact_id,
  COALESCE(cv.last_revision, 0) + 1 AS revision,
  cv.phone_number,
  cv.name
FROM current_values cv
WHERE cv.last_body IS NULL
   OR (cv.last_body::jsonb #>> '{data,phone}') IS DISTINCT FROM ('+' || regexp_replace(cv.phone_number, '\D', '', 'g'))
   OR (cv.last_body::jsonb #>> '{data,name}') IS DISTINCT FROM NULLIF(regexp_replace(left(cv.name, 200), '\s+$', ''), '')
ORDER BY (cv.crm_blocked_reason IS NOT NULL), cv.id
LIMIT COALESCE(NULLIF($5::text, '')::integer, 100);
