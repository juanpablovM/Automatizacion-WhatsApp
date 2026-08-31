WITH updated_message AS (
  UPDATE messages
  SET
    delivery_status = $2::TEXT,
    external_message_id = COALESCE(NULLIF($3::TEXT, ''), external_message_id),
    dispatch_phase = $8::TEXT,
    reconciliation_required = $9::BOOLEAN,
    reconciliation_reason = NULLIF($10::TEXT, ''),
    dispatch_token = NULL,
    updated_at = NOW()
  WHERE id = $1::BIGINT
  RETURNING *
), audit_insert AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id, result,
    before_payload, after_payload, metadata
  )
  SELECT $4::TEXT, 'message', updated_message.id, 'system', 'n8n', $5::TEXT,
         '{}'::JSONB, COALESCE(NULLIF($6::TEXT, '')::JSONB, '{}'::JSONB),
         COALESCE(NULLIF($7::TEXT, '')::JSONB, '{}'::JSONB)
  FROM updated_message
  RETURNING id
)
SELECT updated_message.id AS message_id, updated_message.conversation_id,
       updated_message.lead_id, updated_message.delivery_status,
       updated_message.dispatch_phase, updated_message.external_message_id,
       updated_message.external_message_id AS provider_external_message_id,
       updated_message.text_body, updated_message.idempotency_key,
       updated_message.idempotency_key AS delivery_key,
       updated_message.raw_payload,
       updated_message.reconciliation_required,
       updated_message.reconciliation_reason,
       audit_insert.id AS audit_id
FROM updated_message
LEFT JOIN audit_insert ON TRUE;
