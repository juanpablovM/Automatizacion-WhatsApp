-- Select chat messages to announce to the CRM as message.new (stage C, read
-- side). Protocol revisions 1.2 and 1.3 only: under any other revision it
-- returns no row.
-- p1 protocol revision, p2 CRM_EVENTS_SINCE (ISO timestamp), p3 id prefix,
-- p4 batch size.
--
-- Under 1.2 a message is a candidate when its conversation was already announced to the
-- CRM by a delivered lead.qualified or handoff.created (1.2d) event (so the CRM
-- knows the conversation),
-- it was created at or after CRM_EVENTS_SINCE, it is not deleted, and it has no
-- message.new event yet. Incoming messages always qualify; outgoing ones only
-- once actually sent (delivery_status 'sent', the same rule the conversation
-- history uses), so a queued, failed, cancelled or unknown send never reaches
-- the CRM. Messages of a conversation before its lead qualified are included:
-- the seller sees the whole chat. sender_type is NOT NULL and limited to
-- customer, bot, human and system since migration 018; the builder maps it and
-- blocks anything else. A human reply carries the crm_user_id of the seller
-- assigned to the conversation's lead, except a message sent from the CRM
-- (message.send, migration 041), which carries the crm_seller_id that sent it
-- (an admin is not the assigned seller). sent_at is the provider timestamp when
-- known, else the row creation time, as UTC with milliseconds and Z.
-- Messages blocked on a previous pass go last so they cannot starve the batch.
-- A returning customer who did not ask for a new quote (migration 043): the
-- messages of a conversation linked by continues_conversation_id to an
-- announced one are sent under the announced conversation id, with its lead's
-- seller, while the linked conversation has no lead of its own. Once it
-- re-qualifies into its own lead it is a new quote and follows its own
-- lead.qualified.
-- The announced gate and the continuation mapping above are 1.2 only.
-- Under 1.3 (U4; feature odd/tasks/crm-1-3-customer-threads.md S5) every
-- live conversation's messages are candidates, each sent under its own
-- conversation: contact_id is the customer's thread, so a returning customer's
-- new conversation needs no mapping. Each row carries the contact of its
-- conversation (crm_contact_ensure) and the id prefixes holding its
-- contact.upserted; a message whose contact has no contact.upserted under p3
-- yet is not selected (ordering rule: the contact is announced first). That
-- rule also applies CRM_EVENTS_PHONE_ALLOWLIST (the contact stage only upserts
-- listed contacts), as the announced gate does under 1.2. CRM_EVENTS_SINCE is
-- applied directly.
-- 1.3 backfill (migration 059, U8): nothing of a contact whose backfill under
-- p3 is still pending; its history goes first.
WITH announced AS MATERIALIZED (
  SELECT DISTINCT substring(e.conversation_id FROM '-conversation-([0-9]+)$')::bigint AS conversation_id
  FROM crm_events e
  WHERE $1::text = '1.2'
    AND e.event_type IN ('lead.qualified', 'handoff.created')
    AND e.status = 'delivered'
    AND e.conversation_id LIKE 'wa-' || $3::text || '-conversation-%'
), targets AS MATERIALIZED (
  SELECT a.conversation_id AS message_conversation_id, a.conversation_id AS announced_conversation_id
  FROM announced a
  UNION ALL
  SELECT linked.id, a.conversation_id
  FROM announced a
  JOIN conversations linked ON linked.continues_conversation_id = a.conversation_id
  WHERE linked.deleted_at IS NULL
    AND linked.lead_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM announced own WHERE own.conversation_id = linked.id)
    AND NOT EXISTS (
      SELECT 1
      FROM leads own_lead
      WHERE own_lead.source_conversation_id = linked.id
        AND own_lead.deleted_at IS NULL
    )
  UNION ALL
  SELECT own.id, own.id
  FROM conversations own
  WHERE $1::text = '1.3'
    AND own.deleted_at IS NULL
)
SELECT
  m.id AS message_id,
  t.announced_conversation_id AS conversation_id,
  m.direction,
  m.sender_type,
  m.message_type,
  m.text_body,
  COALESCE(
    attachment.filename,
    NULLIF(btrim(m.raw_payload->>'fileName'), ''),
    NULLIF(btrim(m.raw_payload#>>'{data,message,documentMessage,fileName}'), ''),
    NULLIF(btrim(m.raw_payload#>>'{message,documentMessage,fileName}'), '')
  ) AS file_name,
  to_char(COALESCE(m.external_timestamp, m.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at,
  CASE
    WHEN m.direction = 'outgoing' AND m.sender_type = 'human'
      THEN COALESCE(om.crm_seller_id::text, s.crm_user_id::text)
  END AS crm_user_id,
  ct.contact_id,
  CASE WHEN ct.contact_id IS NOT NULL THEN $3::text END AS contact_upserted_prefixes
FROM targets t
JOIN messages m ON m.conversation_id = t.message_conversation_id
JOIN conversations c ON c.id = m.conversation_id
JOIN conversations announced_conversation ON announced_conversation.id = t.announced_conversation_id
CROSS JOIN LATERAL (
  SELECT CASE WHEN $1::text = '1.3'
    THEN crm_contact_ensure(announced_conversation.source_number_id, announced_conversation.phone_number)
  END AS contact_id
) ct
LEFT JOIN leads l ON l.id = COALESCE(c.lead_id, m.lead_id, announced_conversation.lead_id)
LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
LEFT JOIN crm_outbound_messages om ON om.message_id = m.id
LEFT JOIN LATERAL (
  SELECT NULLIF(btrim(ma.filename), '') AS filename
  FROM message_attachments ma
  WHERE ma.message_id = m.id
    AND NULLIF(btrim(ma.filename), '') IS NOT NULL
  ORDER BY ma.id
  LIMIT 1
) attachment ON TRUE
LEFT JOIN crm_message_blocks b ON b.message_id = m.id
WHERE m.deleted_at IS NULL
  AND m.created_at >= $2::timestamptz
  AND (m.direction = 'incoming' OR (m.direction = 'outgoing' AND m.delivery_status = 'sent'))
  AND (
    $1::text <> '1.3'
    OR (
      EXISTS (
        SELECT 1
        FROM crm_events ce
        WHERE ce.contact_id = ct.contact_id
          AND ce.event_type = 'contact.upserted'
          AND ce.id_prefix = $3::text
      )
      AND NOT crm_contact_backfill_pending(ct.contact_id, $3::text)
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM crm_events e
    WHERE e.message_id = m.id
      AND e.event_type = 'message.new'
  )
ORDER BY (b.message_id IS NOT NULL), m.created_at, m.id
LIMIT COALESCE(NULLIF($4::text, '')::integer, 100);
