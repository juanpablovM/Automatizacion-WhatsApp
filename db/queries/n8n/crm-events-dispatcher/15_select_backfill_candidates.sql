-- Select the 1.3 backfill work of this pass (stage H, read side; migration
-- 059, feature U8: S9, S11). Protocol revision 1.3 only: under any other
-- revision it returns no row.
-- p1 protocol revision, p2 id prefix, p3 handoffs enabled ('true'), p4 message
-- batch size, p5 contact batch size.
--
-- A contact works when its crm_contact_backfills row under p2 is pending, it
-- has its contact.upserted under p2 (the contact stage sends it first) and
-- none of its events under p2 is pending or processing: a step starts only
-- after every earlier event of the contact was delivered or parked, so the
-- CRM receives them in order even across 503 retries. Its next step is the
-- first one with unsettled items (enqueued under p2 or recorded in
-- crm_backfill_blocks = settled), history = created at or before the run's
-- cutoff:
--   history       its leads (lead.qualified with the S11 outcome) and its
--                 resolved handoffs (resolved_at, no routing key), oldest first;
--   open_handoffs its open handoffs (pending, notified, acknowledged), routed
--                 now by crm_route_contact_handoff (058), the 1.2d rules: the
--                 open lead's opportunity returned by the CRM in step history;
--   messages      its messages in sent_at order (provider timestamp, else the
--                 stored time), at most p4 per pass over all contacts;
--   holder        the conversation a seller holds (live lease,
--                 inbound_contact_seller_owned) as ownership.taken with the
--                 contact counter + 1, once;
--   complete      nothing left: Insert Backfill Events marks the contact
--                 completed and the contact.state stage sends its state.
-- Handoffs are part of the backfill only with CRM_EVENTS_HANDOFFS_ENABLED.
-- Each row is { kind, contact_id, entity_id, payload } where payload has the
-- columns the shared builder of that kind reads (as 01, 09, 05, 07 return
-- them). Contacts are taken in id order, p5 per pass.
WITH pending AS MATERIALIZED (
  SELECT b.contact_id, ct.source_number_id, ct.phone_number, r.cutoff_at
  FROM crm_contact_backfills b
  JOIN crm_backfill_runs r ON r.id_prefix = b.id_prefix
  JOIN crm_contacts ct ON ct.id = b.contact_id
  WHERE $1::text = '1.3'
    AND b.id_prefix = $2::text
    AND b.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.contact_id = b.contact_id AND e.event_type = 'contact.upserted' AND e.id_prefix = $2::text
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.contact_id = b.contact_id AND e.id_prefix = $2::text AND e.status IN ('pending', 'processing')
    )
  ORDER BY b.contact_id
  LIMIT COALESCE(NULLIF($5::text, '')::integer, 20)
),
lead_items AS MATERIALIZED (
  SELECT p.contact_id, l.id AS lead_id, l.created_at
  FROM pending p
  JOIN leads l ON l.source_number_id = p.source_number_id AND l.phone_number = p.phone_number
  WHERE l.deleted_at IS NULL
    AND l.created_at <= p.cutoff_at
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.lead_id = l.id AND e.event_type = 'lead.qualified' AND e.id_prefix = $2::text
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_backfill_blocks bb WHERE bb.id_prefix = $2::text AND bb.kind = 'lead' AND bb.entity_id = l.id
    )
),
handoff_items AS MATERIALIZED (
  SELECT p.contact_id, h.id AS handoff_id, h.created_at,
         h.estado IN ('pending', 'notified', 'acknowledged') AS is_open
  FROM pending p
  JOIN handoffs h ON h.phone_number = p.phone_number
  LEFT JOIN conversations hc ON hc.id = h.conversation_id
  WHERE $3::text = 'true'
    AND COALESCE(h.source_number_id, hc.source_number_id) = p.source_number_id
    AND h.deleted_at IS NULL
    AND h.created_at <= p.cutoff_at
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.handoff_id = h.id AND e.event_type = 'handoff.created' AND e.id_prefix = $2::text
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_backfill_blocks bb WHERE bb.id_prefix = $2::text AND bb.kind = 'handoff' AND bb.entity_id = h.id
    )
),
message_items AS MATERIALIZED (
  SELECT p.contact_id, m.id AS message_id, c.id AS conversation_id,
         COALESCE(m.external_timestamp, m.created_at) AS sent_at
  FROM pending p
  JOIN conversations c ON c.source_number_id = p.source_number_id AND c.phone_number = p.phone_number
  JOIN messages m ON m.conversation_id = c.id
  WHERE c.deleted_at IS NULL
    AND m.deleted_at IS NULL
    AND m.created_at <= p.cutoff_at
    AND (m.direction = 'incoming' OR (m.direction = 'outgoing' AND m.delivery_status = 'sent'))
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.message_id = m.id AND e.event_type = 'message.new' AND e.id_prefix = $2::text
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_backfill_blocks bb WHERE bb.id_prefix = $2::text AND bb.kind = 'message' AND bb.entity_id = m.id
    )
),
holder_items AS MATERIALIZED (
  SELECT p.contact_id, x.conversation_id, x.change_id, x.ownership_version, x.source, x.seller_id
  FROM pending p
  CROSS JOIN LATERAL (
    SELECT cco.conversation_id, cco.ownership_version, cco.source, cco.seller_id,
      (
        SELECT ch.id
        FROM crm_ownership_changes ch
        WHERE ch.conversation_id = cco.conversation_id AND ch.change_kind = 'taken'
        ORDER BY ch.ownership_version DESC
        LIMIT 1
      ) AS change_id
    FROM conversations c
    JOIN crm_conversation_ownership cco ON cco.conversation_id = c.id
    WHERE c.source_number_id = p.source_number_id AND c.phone_number = p.phone_number
      AND c.deleted_at IS NULL
      AND cco.owner_kind = 'seller'
    ORDER BY cco.changed_at DESC, cco.conversation_id DESC
    LIMIT 1
  ) x
  WHERE x.change_id IS NOT NULL
    AND inbound_contact_seller_owned(p.source_number_id, p.phone_number)
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.contact_id = p.contact_id AND e.id_prefix = $2::text
        AND e.event_type IN ('ownership.taken', 'ownership.released')
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_backfill_blocks bb WHERE bb.id_prefix = $2::text AND bb.kind = 'holder' AND bb.entity_id = p.contact_id
    )
),
steps AS MATERIALIZED (
  SELECT p.*,
    CASE
      WHEN EXISTS (SELECT 1 FROM lead_items li WHERE li.contact_id = p.contact_id)
        OR EXISTS (SELECT 1 FROM handoff_items hi WHERE hi.contact_id = p.contact_id AND NOT hi.is_open) THEN 'history'
      WHEN EXISTS (SELECT 1 FROM handoff_items hi WHERE hi.contact_id = p.contact_id AND hi.is_open) THEN 'open_handoffs'
      WHEN EXISTS (SELECT 1 FROM message_items mi WHERE mi.contact_id = p.contact_id) THEN 'messages'
      WHEN EXISTS (SELECT 1 FROM holder_items ho WHERE ho.contact_id = p.contact_id) THEN 'holder'
      ELSE 'complete'
    END AS step
  FROM pending p
),
-- Open handoffs are routed here, once each, in creation order (as 09 does);
-- rows locked by a concurrent pass are skipped and retried.
open_handoffs AS MATERIALIZED (
  SELECT hi.contact_id, h.id AS handoff_id, h.created_at
  FROM handoff_items hi
  JOIN steps st ON st.contact_id = hi.contact_id AND st.step = 'open_handoffs'
  JOIN handoffs h ON h.id = hi.handoff_id
  WHERE hi.is_open
  ORDER BY h.created_at, h.id
  FOR UPDATE OF h SKIP LOCKED
),
routed AS MATERIALIZED (
  SELECT oh.contact_id, oh.handoff_id, oh.created_at, r.crm_opportunity_id, r.crm_routing_seller_id
  FROM open_handoffs oh
  CROSS JOIN LATERAL crm_route_contact_handoff(oh.handoff_id, NULL) r
),
handoff_rows AS (
  SELECT hi.contact_id, hi.handoff_id, hi.created_at, hi.is_open, NULL::uuid AS crm_opportunity_id,
         NULL::bigint AS crm_routing_seller_id
  FROM handoff_items hi
  JOIN steps st ON st.contact_id = hi.contact_id AND st.step = 'history'
  WHERE NOT hi.is_open
  UNION ALL
  SELECT ro.contact_id, ro.handoff_id, ro.created_at, TRUE, ro.crm_opportunity_id, ro.crm_routing_seller_id
  FROM routed ro
),
message_batch AS MATERIALIZED (
  SELECT mi.*
  FROM message_items mi
  JOIN steps st ON st.contact_id = mi.contact_id AND st.step = 'messages'
  ORDER BY mi.contact_id, mi.sent_at, mi.message_id
  LIMIT COALESCE(NULLIF($4::text, '')::integer, 100)
)
SELECT w.kind, w.contact_id, w.entity_id, w.payload
FROM (
  -- history: leads (as 01 returns them, plus the S11 outcome)
  SELECT 'lead' AS kind, li.contact_id, li.lead_id AS entity_id, li.created_at AS sort_at, 1 AS kind_order,
    jsonb_build_object(
      'lead_id', l.id,
      'revision', (
        SELECT COALESCE(MAX(e.revision), 0) + 1 FROM crm_events e
        WHERE e.lead_id = l.id AND e.event_type = 'lead.qualified'
      ),
      'conversation_id', COALESCE(
        l.source_conversation_id,
        (SELECT c.id FROM conversations c WHERE c.lead_id = l.id AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 1)
      ),
      'phone_number', l.phone_number,
      'whatsapp_name', l.whatsapp_name,
      'service', l.service,
      'city', l.city,
      'requirement', l.requirement,
      'qualification_context', l.qualification_context,
      'crm_user_id', s.crm_user_id::text,
      'crm_source_hash', crm_lead_source_hash(l.id),
      'source_number_phone', wn.phone_number,
      'advisor_output_payload', (
        SELECT ad.output_payload
        FROM advisor_decisions ad
        LEFT JOIN conversations c_ad ON c_ad.id = ad.conversation_id
        WHERE ad.lead_id = l.id OR c_ad.lead_id = l.id
        ORDER BY ad.created_at DESC, ad.id DESC
        LIMIT 1
      ),
      'contact_id', li.contact_id,
      'contact_upserted_prefixes', $2::text,
      'outcome', o.outcome,
      'closed_at', to_char(o.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ) AS payload
  FROM lead_items li
  JOIN steps st ON st.contact_id = li.contact_id AND st.step = 'history'
  JOIN leads l ON l.id = li.lead_id
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
  LEFT JOIN whatsapp_numbers wn ON wn.id = l.source_number_id
  CROSS JOIN LATERAL crm_backfill_lead_outcome(
    l.clickup_status, l.clickup_status_at, l.created_at, crm_lead_last_activity_at(l.id), st.cutoff_at
  ) o

  UNION ALL
  -- history (resolved) and open_handoffs: handoffs (as 09 returns them)
  SELECT 'handoff', hr.contact_id, hr.handoff_id, hr.created_at, 2,
    jsonb_build_object(
      'handoff_id', h.id,
      'revision', (
        SELECT COALESCE(MAX(e.revision), 0) + 1 FROM crm_events e
        WHERE e.handoff_id = h.id AND e.event_type = 'handoff.created'
      ),
      'conversation_id', h.conversation_id,
      'area', h.area,
      'motivo', h.motivo,
      'escalation_reason', h.escalation_reason,
      'prioridad', h.prioridad,
      'phone_number', h.phone_number,
      'crm_opportunity_id', CASE WHEN hr.is_open THEN hr.crm_opportunity_id::text END,
      'crm_seller_id', CASE WHEN hr.is_open AND hr.crm_opportunity_id IS NULL THEN rs.crm_user_id::text END,
      'customer_name', COALESCE(
        (
          SELECT NULLIF(btrim(l.whatsapp_name), '')
          FROM conversations c
          JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
          WHERE c.id = h.conversation_id
        ),
        (
          SELECT NULLIF(btrim(l.whatsapp_name), '')
          FROM leads l
          WHERE l.phone_number = h.phone_number AND l.deleted_at IS NULL
            AND NULLIF(btrim(l.whatsapp_name), '') IS NOT NULL
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT 1
        )
      ),
      'last_customer_message', (
        SELECT m.text_body
        FROM messages m
        WHERE m.conversation_id = h.conversation_id
          AND m.direction = 'incoming'
          AND m.deleted_at IS NULL
          AND NULLIF(btrim(m.text_body), '') IS NOT NULL
          AND m.created_at <= h.created_at
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ),
      'contact_id', hr.contact_id,
      'contact_upserted_prefixes', $2::text,
      'resolved_at', CASE WHEN NOT hr.is_open THEN
        to_char(COALESCE(h.resolved_at, h.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END
    )
  FROM handoff_rows hr
  JOIN handoffs h ON h.id = hr.handoff_id
  LEFT JOIN sellers rs ON rs.id = hr.crm_routing_seller_id

  UNION ALL
  -- messages (as 05 returns them under 1.3)
  SELECT 'message', mb.contact_id, mb.message_id, mb.sent_at, 3,
    jsonb_build_object(
      'message_id', m.id,
      'conversation_id', mb.conversation_id,
      'direction', m.direction,
      'sender_type', m.sender_type,
      'message_type', m.message_type,
      'text_body', m.text_body,
      'file_name', COALESCE(
        (
          SELECT NULLIF(btrim(ma.filename), '')
          FROM message_attachments ma
          WHERE ma.message_id = m.id AND NULLIF(btrim(ma.filename), '') IS NOT NULL
          ORDER BY ma.id
          LIMIT 1
        ),
        NULLIF(btrim(m.raw_payload->>'fileName'), ''),
        NULLIF(btrim(m.raw_payload#>>'{data,message,documentMessage,fileName}'), ''),
        NULLIF(btrim(m.raw_payload#>>'{message,documentMessage,fileName}'), '')
      ),
      'sent_at', to_char(mb.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'crm_user_id', CASE
        WHEN m.direction = 'outgoing' AND m.sender_type = 'human'
          THEN COALESCE(om.crm_seller_id::text, s.crm_user_id::text)
      END,
      'contact_id', mb.contact_id,
      'contact_upserted_prefixes', $2::text
    )
  FROM message_batch mb
  JOIN messages m ON m.id = mb.message_id
  JOIN conversations c ON c.id = mb.conversation_id
  LEFT JOIN leads l ON l.id = COALESCE(c.lead_id, m.lead_id)
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
  LEFT JOIN crm_outbound_messages om ON om.message_id = m.id

  UNION ALL
  -- holder (as 07 returns a change under 1.3, with the next contact counter)
  SELECT 'holder', ho.contact_id, ho.contact_id, NULL, 4,
    jsonb_build_object(
      'change_id', ho.change_id,
      'conversation_id', ho.conversation_id,
      'ownership_version', ho.ownership_version,
      'change_kind', 'taken',
      'source', ho.source,
      'reason', NULL,
      'crm_user_id', s.crm_user_id::text,
      'contact_id', ho.contact_id,
      'contact_upserted_prefixes', $2::text,
      'contact_version', ct.ownership_version + 1
    )
  FROM holder_items ho
  JOIN steps st ON st.contact_id = ho.contact_id AND st.step = 'holder'
  JOIN crm_contacts ct ON ct.id = ho.contact_id
  LEFT JOIN sellers s ON s.id = ho.seller_id AND s.deleted_at IS NULL

  UNION ALL
  SELECT 'complete', st.contact_id, st.contact_id, NULL, 5, '{}'::jsonb
  FROM steps st
  WHERE st.step = 'complete'
) w
ORDER BY w.contact_id, w.sort_at NULLS LAST, w.kind_order, w.entity_id;
