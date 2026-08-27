-- Persist Conversation State (embedded en wa-conversation-orchestrator.json)
-- Actualiza o crea la conversación, inserta el mensaje entrante, adjuntos,
-- audit log, y la decisión del advisor.
--
-- Nota: Este es el SQL REFERENCIA. El workflow usa el query completo con
-- todos los CTEs (updated_existing_conversation, created_conversation,
-- incoming_message, attachment_insert, audit_insert, advisor_decision_insert).
--
-- Esta versión simplificada documenta la estructura de UPDATE de la
-- conversación. Para el query completo, ver el workflow JSON.

UPDATE conversations c
SET
  current_step = COALESCE(NULLIF(:current_step::text, ''), c.current_step),
  conversation_status_id = cs.id,
  lead_id = CASE
    WHEN :reset_conversation_lead::boolean THEN NULL
    ELSE COALESCE(NULLIF(:lead_id::text, '')::bigint, c.lead_id)
  END,
  source_number_id = COALESCE(NULLIF(:source_number_id::text, '')::bigint, c.source_number_id),
  qualification_context = COALESCE(NULLIF(:qualification_context::text, '')::jsonb, c.qualification_context),
  pending_question_key = NULLIF(:pending_question_key::text, ''),
  last_message_at = NOW(),
  handed_to_sales_at = CASE
    WHEN cs.code = 'handed_to_sales' THEN NOW()
    WHEN :reset_conversation_lead::boolean THEN NULL
    ELSE c.handed_to_sales_at
  END,
  closed_at = CASE
    WHEN cs.code IN ('closed', 'inactive_timeout') THEN COALESCE(c.closed_at, NOW())
    ELSE c.closed_at
  END,
  updated_at = NOW()
FROM conversation_statuses cs
WHERE c.id = :conversation_id::bigint
  AND cs.code = :conversation_status_code::text
RETURNING
  c.id,
  c.lead_id,
  c.current_step,
  c.last_message_at;
