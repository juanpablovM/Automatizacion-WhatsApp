-- Inputs esperados:
-- :phone_number
-- :source_number_id (nullable)

WITH latest_conversation AS (
  SELECT
    c.id AS conversation_id,
    c.lead_id,
    c.source_number_id,
    c.phone_number,
    c.current_step,
    c.started_at,
    c.last_message_at,
    cs.code AS conversation_status_code,
    cs.label AS conversation_status_label
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  WHERE c.deleted_at IS NULL
    AND c.phone_number = :phone_number
    AND (:source_number_id IS NULL OR c.source_number_id = :source_number_id)
  ORDER BY c.started_at DESC
  LIMIT 1
),
latest_lead AS (
  SELECT
    l.id AS previous_lead_id,
    l.whatsapp_name,
    l.phone_number,
    l.service,
    l.city,
    l.requirement,
    l.source_number_id AS previous_source_number_id,
    ls.code AS lead_status_code
  FROM leads l
  JOIN lead_statuses ls ON ls.id = l.lead_status_id
  WHERE l.deleted_at IS NULL
    AND l.phone_number = :phone_number
  ORDER BY l.created_at DESC
  LIMIT 1
)
SELECT
  lc.conversation_id,
  lc.lead_id,
  lc.source_number_id,
  lc.phone_number,
  lc.current_step,
  lc.started_at,
  lc.last_message_at,
  lc.conversation_status_code,
  lc.conversation_status_label,
  CASE
    WHEN lc.conversation_id IS NOT NULL
      AND lc.last_message_at >= NOW() - INTERVAL '24 hours'
    THEN TRUE
    ELSE FALSE
  END AS has_active_conversation,
  ll.previous_lead_id,
  ll.whatsapp_name AS previous_whatsapp_name,
  ll.service AS previous_service,
  ll.city AS previous_city,
  ll.requirement AS previous_requirement,
  ll.lead_status_code AS previous_lead_status_code
FROM latest_conversation lc
FULL OUTER JOIN latest_lead ll ON TRUE;

