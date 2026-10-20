-- Preserve commercial state, durably create the internal handoff receipt, and
-- only then release the static contingency copy into the outgoing outbox.
WITH execution_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('v3-contingency:' || $1::TEXT, 0))
), target AS MATERIALIZED (
  SELECT execution.*, decision.output_payload, decision.validation_errors,
         event.processing_token,
         event.received_at AS turn_received_at,
         conversation.qualification_context, conversation.phone_number,
         conversation.source_number_id, conversation.lead_id,
         command.value AS handoff_command, number.instance_name
  FROM conversation_turn_executions execution
  JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
  JOIN inbound_events event ON event.id = execution.inbound_event_id
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  LEFT JOIN whatsapp_numbers number ON number.id = conversation.source_number_id
  CROSS JOIN LATERAL jsonb_array_elements(decision.output_payload->'effect_commands') command(value)
  CROSS JOIN execution_lock
  WHERE execution.decision_id = $1::TEXT
    AND execution.state IN ('prepared', 'delivery_pending', 'delivered')
    AND event.processing_token = $2::TEXT
    AND decision.output_payload->>'version' = 'system_contingency_decision/v3'
    AND decision.output_payload->>'decision_id' = execution.decision_id
    AND decision.output_payload->'state_mutations' = '[]'::JSONB
    AND command.value->>'type' = 'internal_handoff'
    AND COALESCE((command.value->>'required_before_reply')::BOOLEAN, FALSE)
    AND decision.output_payload#>>'{reply,delivery_key}' = execution.delivery_key
  FOR UPDATE OF execution, decision, event, conversation
), conversation_touch AS (
  UPDATE conversations conversation
  SET last_message_at = GREATEST(conversation.last_message_at, target.turn_received_at, NOW()),
      conversation_status_id = CASE WHEN target.handoff_command#>>'{payload,recovery_reason}' = 'no_progress_commercial_question_loop'
        THEN (SELECT id FROM conversation_statuses WHERE code='escalation_required') ELSE conversation.conversation_status_id END,
      current_step = CASE WHEN target.handoff_command#>>'{payload,recovery_reason}' = 'no_progress_commercial_question_loop'
        THEN 'escalation' ELSE conversation.current_step END,
      pending_question_key = CASE WHEN target.handoff_command#>>'{payload,recovery_reason}' = 'no_progress_commercial_question_loop'
        THEN NULL ELSE conversation.pending_question_key END,
      updated_at = NOW()
  FROM target
  WHERE conversation.id = target.conversation_id
    AND target.state = 'prepared'
  RETURNING conversation.id
), persisted_handoff_receipt AS MATERIALIZED (
  -- A completed ensure command is bound to its original resource, not whichever
  -- recovery handoff happens to be open when this turn is replayed.
  SELECT receipt.value
  FROM target
  CROSS JOIN LATERAL jsonb_array_elements(target.effect_receipt_refs) receipt(value)
  WHERE target.state IN ('delivery_pending', 'delivered')
    AND receipt.value->>'schema' = 'internal_handoff_receipt/v3'
    AND receipt.value->>'status' = 'succeeded'
    AND receipt.value->>'operation_key' = target.handoff_command->>'operation_key'
    AND (NOT (receipt.value ? 'requested_payload_digest')
      OR receipt.value->>'requested_payload_digest' = target.handoff_command->>'payload_digest')
), pinned_handoff AS MATERIALIZED (
  SELECT handoff.*
  FROM target
  CROSS JOIN persisted_handoff_receipt receipt
  JOIN handoffs handoff ON handoff.id::TEXT = receipt.value->>'handoff_id'
  WHERE handoff.conversation_id = target.conversation_id
    AND handoff.phone_number IS NOT DISTINCT FROM target.phone_number
    AND handoff.source_number_id IS NOT DISTINCT FROM target.source_number_id
    AND handoff.motivo = 'v3_recovery'
    AND handoff.deleted_at IS NULL
    AND (NOT (receipt.value ? 'persisted_resource_operation_key')
      OR receipt.value->>'persisted_resource_operation_key' = handoff.idempotency_key)
), existing_handoff AS MATERIALIZED (
  SELECT existing.*
  FROM target
  JOIN LATERAL (
    SELECT handoff.*
    FROM handoffs handoff
    WHERE target.state = 'prepared'
      AND handoff.conversation_id = target.conversation_id
      AND handoff.phone_number IS NOT DISTINCT FROM target.phone_number
      AND handoff.source_number_id IS NOT DISTINCT FROM target.source_number_id
      AND handoff.motivo = 'v3_recovery'
      AND handoff.estado IN ('pending', 'notified', 'acknowledged')
      AND handoff.deleted_at IS NULL
    ORDER BY handoff.id
    LIMIT 1
  ) existing ON TRUE
), handoff_insert AS (
  INSERT INTO handoffs (
    idempotency_key, conversation_id, phone_number, source_number_id,
    inbound_event_id, motivo, area, area_label, prioridad, responsable,
    trigger, escalation_reason, escalation_area, intent, metadata
  )
  SELECT target.handoff_command->>'operation_key', target.conversation_id,
         target.phone_number, target.source_number_id, target.inbound_event_id,
         target.handoff_command#>>'{payload,motive}',
         target.handoff_command#>>'{payload,area}',
         target.handoff_command#>>'{payload,area_label}',
         target.handoff_command#>>'{payload,priority}',
         target.handoff_command#>>'{payload,owner}',
         target.handoff_command#>>'{payload,trigger}',
         CASE WHEN target.handoff_command#>>'{payload,recovery_reason}' = 'no_progress_commercial_question_loop'
           THEN 'no_progress_commercial_question_loop' ELSE 'v3_recovery' END, target.handoff_command#>>'{payload,area}',
         'v3_contingency',
         jsonb_build_object(
           'decision_id', target.decision_id,
           'payload_digest', target.handoff_command->>'payload_digest'
         )
  FROM target
  CROSS JOIN conversation_touch
  WHERE target.state = 'prepared'
    AND NOT EXISTS (SELECT 1 FROM existing_handoff)
  ON CONFLICT (idempotency_key) WHERE deleted_at IS NULL DO NOTHING
  RETURNING *
), fixed_handoff AS MATERIALIZED (
  SELECT handoff_insert.* FROM handoff_insert
  UNION ALL
  SELECT existing_handoff.* FROM existing_handoff
  WHERE NOT EXISTS (SELECT 1 FROM handoff_insert)
  UNION ALL
  SELECT handoff.* FROM handoffs handoff
  JOIN target ON target.handoff_command->>'operation_key' = handoff.idempotency_key
  WHERE target.state = 'prepared'
    AND handoff.conversation_id = target.conversation_id
    AND handoff.phone_number IS NOT DISTINCT FROM target.phone_number
    AND handoff.source_number_id IS NOT DISTINCT FROM target.source_number_id
    AND handoff.motivo = 'v3_recovery'
    AND handoff.estado IN ('pending', 'notified', 'acknowledged')
    AND handoff.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM handoff_insert)
    AND NOT EXISTS (SELECT 1 FROM existing_handoff)
  UNION ALL
  SELECT pinned_handoff.* FROM pinned_handoff
), handoff_receipt AS MATERIALIZED (
  SELECT jsonb_build_object(
    'schema', 'internal_handoff_receipt/v3',
    'operation_key', target.handoff_command->>'operation_key',
    'persisted_resource_operation_key', fixed_handoff.idempotency_key,
    'reused_existing', fixed_handoff.idempotency_key <> target.handoff_command->>'operation_key',
    'requested_payload_digest', target.handoff_command->>'payload_digest',
    'handoff_id', fixed_handoff.id,
    'status', 'succeeded',
    'created_at', fixed_handoff.created_at
  ) AS value
  FROM fixed_handoff
  CROSS JOIN target
  WHERE target.state = 'prepared'
  UNION ALL
  SELECT receipt.value FROM persisted_handoff_receipt receipt
  CROSS JOIN pinned_handoff
), outbox AS (
  INSERT INTO messages (
    conversation_id, lead_id, direction, sender_type, message_type, delivery_status,
    text_body, raw_payload, provider_instance_name, idempotency_key,
    inbound_event_id, dispatch_phase, dispatch_token, claimed_at
  )
  SELECT target.conversation_id, target.lead_id, 'outgoing', 'bot', 'text', 'queued',
         target.output_payload#>>'{reply,text}',
         jsonb_build_object(
           'number', target.phone_number,
           -- `Mark Outbound Sending` posts this column verbatim, so the
           -- reply text belongs in it, not only in `text_body`.
           'text', target.output_payload#>>'{reply,text}',
           'version', 'system_contingency_decision/v3',
           'decision_id', target.decision_id,
           'reply_sha256', target.output_payload#>>'{reply,sha256}',
           'handoff_receipt', handoff_receipt.value
         ),
         target.instance_name, target.delivery_key, target.inbound_event_id,
         'reserved', NULL, NULL
  FROM target
  CROSS JOIN handoff_receipt
  WHERE target.state = 'prepared'
  ON CONFLICT (idempotency_key)
    WHERE direction = 'outgoing' AND idempotency_key IS NOT NULL AND deleted_at IS NULL
  DO NOTHING
  RETURNING *
), fixed_message AS MATERIALIZED (
  SELECT outbox.* FROM outbox
  UNION ALL
  SELECT message.* FROM messages message
  JOIN target ON target.delivery_key = message.idempotency_key
  WHERE message.direction = 'outgoing' AND message.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM outbox)
), committed AS (
  UPDATE conversation_turn_executions execution
  SET state = 'delivery_pending',
      effect_receipt_refs = CASE
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(execution.effect_receipt_refs) item
          WHERE item->>'operation_key' = target.handoff_command->>'operation_key'
        ) THEN execution.effect_receipt_refs
        ELSE execution.effect_receipt_refs || jsonb_build_array(handoff_receipt.value)
      END,
      state_receipt = jsonb_build_object(
        'schema', 'conversation_state_receipt/v3',
        'decision_id', target.decision_id,
        'preserved', TRUE,
        'state_before', target.qualification_context,
        'state_after', target.qualification_context
      ),
      delivery_message_id = fixed_message.id,
      updated_at = NOW()
  FROM target
  CROSS JOIN handoff_receipt
  CROSS JOIN fixed_message
  WHERE execution.id = target.id AND target.state = 'prepared'
  RETURNING execution.*
), audit_insert AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
  )
  SELECT 'v3_contingency_committed', 'conversation_turn_execution', target.id,
         'system', 'v3-saga', 'success',
         jsonb_build_object(
           'decision_id', target.decision_id,
           'handoff_receipt', handoff_receipt.value,
           'delivery_message_id', fixed_message.id,
           'commercial_state_preserved', TRUE,
           -- Read back from the immutable contingency decision, so the audit
           -- trail keeps the cause without a new workflow input.
           'recovery_reason', target.handoff_command#>>'{payload,recovery_reason}',
           'validation_error_codes', target.validation_errors - 'v3_recovery_contingency'
         )
  FROM target
  CROSS JOIN handoff_receipt
  CROSS JOIN fixed_message
  WHERE target.state = 'prepared'
  RETURNING id
), result_execution AS MATERIALIZED (
  SELECT committed.*, FALSE AS replayed FROM committed
  UNION ALL
  SELECT execution.*, TRUE AS replayed
  FROM conversation_turn_executions execution
  JOIN target ON target.id = execution.id
  WHERE target.state IN ('delivery_pending', 'delivered')
)
SELECT result_execution.*, fixed_handoff.id AS handoff_id,
       handoff_receipt.value AS handoff_receipt,
       fixed_message.text_body, fixed_message.raw_payload,
       fixed_message.raw_payload->>'reply_sha256' AS reply_sha256
FROM result_execution
CROSS JOIN fixed_handoff
CROSS JOIN handoff_receipt
JOIN fixed_message ON fixed_message.id = result_execution.delivery_message_id
WHERE fixed_message.conversation_id = result_execution.conversation_id
  AND fixed_message.raw_payload->'handoff_receipt' = handoff_receipt.value;
