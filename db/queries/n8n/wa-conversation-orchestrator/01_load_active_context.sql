-- Load Conversation State (embedded en wa-conversation-orchestrator.json)
-- Carga el contexto activo de la conversación + lead anterior + mensajes recientes.
-- 
-- Nota: Este es el SQL REFERENCIA. El workflow embebe este mismo query
-- con parámetros posicionales ($1, $2, ...). Si modificás este archivo,
-- actualizá también el JSON del workflow y viceversa.
--
-- Parámetros (named style para documentación):
--   :phone_number        TEXT     — Número de WhatsApp del contacto
--   :source_number_id    BIGINT   — ID del número emisor (opcional)
--   :whatsapp_name       TEXT     — Nombre en WhatsApp (opcional)
--   :external_contact_id TEXT     — ID externo del contacto (opcional)
--   :external_message_id TEXT     — ID del mensaje en Evolution API
--   :message_type        TEXT     — Tipo de mensaje (text, image, etc.)
--   :text_body           TEXT     — Cuerpo del mensaje
--   :raw_payload_json    TEXT     — Payload completo de Evolution (JSON)
--   :attachment_*        varios   — Metadata del attachment (opcional)
--   :instance_name       TEXT     — Nombre de la instancia Evolution API

WITH input_payload AS (
  SELECT
    :phone_number::text AS phone_number,
    NULLIF(:source_number_id::text, '')::bigint AS source_number_id,
    NULLIF(:whatsapp_name::text, '') AS whatsapp_name,
    NULLIF(:external_contact_id::text, '') AS external_contact_id,
    NULLIF(:external_message_id::text, '') AS external_message_id,
    COALESCE(NULLIF(:message_type::text, ''), 'unknown') AS message_type,
    NULLIF(:text_body::text, '') AS text_body,
    COALESCE(NULLIF(:raw_payload_json::text, ''), '{}') AS raw_payload_json,
    NULLIF(:attachment_type::text, '') AS attachment_type,
    NULLIF(:mime_type::text, '') AS mime_type,
    NULLIF(:filename::text, '') AS filename,
    NULLIF(:external_media_id::text, '') AS external_media_id,
    NULLIF(:external_url::text, '') AS external_url,
    NULLIF(:sha256::text, '') AS sha256,
    NULLIF(:file_size_raw::text, '') AS file_size_raw,
    NULLIF(:instance_name::text, '') AS instance_name
),
latest_conversation AS (
  SELECT
    c.id AS conversation_id,
    c.lead_id,
    c.source_number_id,
    c.phone_number,
    c.current_step,
    c.qualification_context,
    c.pending_question_key,
    c.started_at,
    c.last_message_at,
    cs.code AS conversation_status_code,
    cs.label AS conversation_status_label
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  JOIN input_payload ip ON TRUE
  WHERE c.deleted_at IS NULL
    AND c.phone_number = ip.phone_number
    AND (ip.source_number_id IS NULL OR c.source_number_id = ip.source_number_id)
  ORDER BY c.started_at DESC
  LIMIT 1
),
latest_conversation_state AS (
  SELECT
    al.after_payload->>'service' AS state_service,
    al.after_payload->>'city' AS state_city,
    al.after_payload->>'requirement' AS state_requirement,
    al.after_payload->>'current_step' AS state_current_step
  FROM audit_logs al
  JOIN latest_conversation lc ON TRUE
  WHERE al.entity_type = 'conversation'
    AND al.entity_id = lc.conversation_id
    AND al.event_name = 'conversation_state_evaluated'
  ORDER BY al.created_at DESC, al.id DESC
  LIMIT 1
),
latest_conversation_reset AS (
  SELECT MAX(al.created_at) AS reset_at
  FROM audit_logs al
  JOIN latest_conversation lc ON TRUE
  WHERE al.entity_type = 'conversation'
    AND al.entity_id = lc.conversation_id
    AND al.event_name = 'conversation_state_evaluated'
    AND COALESCE((al.metadata->>'reset_conversation_lead')::boolean, FALSE)
),
recent_messages AS (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'role', CASE WHEN history.direction = 'incoming' THEN 'user' ELSE 'assistant' END,
        'content', history.text_body
      )
      ORDER BY history.created_at ASC, history.id ASC
    ),
    '[]'::jsonb
  ) AS recent_messages
  FROM (
    SELECT
      m.id,
      m.direction,
      m.text_body,
      m.created_at
    FROM messages m
    JOIN latest_conversation lc ON lc.conversation_id = m.conversation_id
    LEFT JOIN latest_conversation_reset lcr ON TRUE
    WHERE m.deleted_at IS NULL
      AND NULLIF(BTRIM(m.text_body), '') IS NOT NULL
      AND (
        m.direction = 'incoming'
        OR (m.direction = 'outgoing' AND m.delivery_status = 'sent')
      )
      AND (lcr.reset_at IS NULL OR m.created_at > lcr.reset_at)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 8
  ) history
),
latest_lead AS (
  SELECT
    l.id AS previous_lead_id,
    l.whatsapp_name,
    l.phone_number,
    l.service,
    l.city,
    l.requirement,
    l.created_at AS previous_lead_created_at,
    l.source_number_id AS previous_source_number_id,
    ls.code AS lead_status_code
  FROM leads l
  JOIN lead_statuses ls ON ls.id = l.lead_status_id
  JOIN input_payload ip ON TRUE
  WHERE l.deleted_at IS NULL
    AND l.phone_number = ip.phone_number
  ORDER BY l.created_at DESC
  LIMIT 1
)
SELECT
  ip.phone_number,
  ip.source_number_id AS input_source_number_id,
  ip.instance_name,
  ip.whatsapp_name AS input_whatsapp_name,
  ip.external_contact_id AS input_external_contact_id,
  ip.external_message_id AS input_external_message_id,
  ip.message_type,
  ip.text_body,
  ip.raw_payload_json,
  ip.attachment_type,
  ip.mime_type,
  ip.filename,
  ip.external_media_id,
  ip.external_url,
  ip.sha256,
  ip.file_size_raw,
  lc.conversation_id,
  lc.lead_id,
  lc.source_number_id,
  lc.current_step,
  COALESCE(lc.qualification_context, '{}'::jsonb) AS qualification_context,
  lc.pending_question_key,
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
  lcs.state_service,
  lcs.state_city,
  lcs.state_requirement,
  lcs.state_current_step,
  COALESCE(rm.recent_messages, '[]'::jsonb) AS recent_messages,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.previous_lead_id END AS previous_lead_id,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.whatsapp_name END AS previous_whatsapp_name,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.service END AS previous_service,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.city END AS previous_city,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.requirement END AS previous_requirement,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.lead_status_code END AS previous_lead_status_code
FROM input_payload ip
LEFT JOIN latest_conversation lc ON TRUE
LEFT JOIN latest_conversation_state lcs ON TRUE
LEFT JOIN recent_messages rm ON TRUE
LEFT JOIN latest_conversation_reset lcr ON TRUE
LEFT JOIN latest_lead ll ON TRUE;
