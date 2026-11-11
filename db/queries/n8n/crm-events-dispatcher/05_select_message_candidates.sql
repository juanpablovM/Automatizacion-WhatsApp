-- Select chat messages to announce to the CRM as message.new (stage C, read
-- side). Protocol revision 1.2 only: under any other revision it returns no row.
-- p1 protocol revision, p2 CRM_EVENTS_SINCE (ISO timestamp), p3 id prefix,
-- p4 batch size.
--
-- A message is a candidate when its conversation was already announced to the
-- CRM by a delivered lead.qualified event (so the CRM knows the conversation),
-- it was created at or after CRM_EVENTS_SINCE, it is not deleted, and it has no
-- message.new event yet. Incoming messages always qualify; outgoing ones only
-- once actually sent (delivery_status 'sent', the same rule the conversation
-- history uses), so a queued, failed, cancelled or unknown send never reaches
-- the CRM. Messages of a conversation before its lead qualified are included:
-- the seller sees the whole chat. sender_type is NOT NULL and limited to
-- customer, bot, human and system since migration 018; the builder maps it and
-- blocks anything else. A human reply carries the crm_user_id of the seller
-- assigned to the conversation's lead. sent_at is the provider timestamp when
-- known, else the row creation time, as UTC with milliseconds and Z.
-- Messages blocked on a previous pass go last so they cannot starve the batch.
WITH announced AS MATERIALIZED (
  SELECT DISTINCT substring(e.conversation_id FROM '-conversation-([0-9]+)$')::bigint AS conversation_id
  FROM crm_events e
  WHERE $1::text = '1.2'
    AND e.event_type = 'lead.qualified'
    AND e.status = 'delivered'
    AND e.conversation_id LIKE 'wa-' || $3::text || '-conversation-%'
)
SELECT
  m.id AS message_id,
  m.conversation_id,
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
  CASE WHEN m.direction = 'outgoing' AND m.sender_type = 'human' THEN s.crm_user_id::text END AS crm_user_id
FROM announced a
JOIN messages m ON m.conversation_id = a.conversation_id
JOIN conversations c ON c.id = m.conversation_id
LEFT JOIN leads l ON l.id = COALESCE(c.lead_id, m.lead_id)
LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
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
  AND NOT EXISTS (
    SELECT 1
    FROM crm_events e
    WHERE e.message_id = m.id
      AND e.event_type = 'message.new'
  )
ORDER BY (b.message_id IS NOT NULL), m.created_at, m.id
LIMIT COALESCE(NULLIF($4::text, '')::integer, 100);
