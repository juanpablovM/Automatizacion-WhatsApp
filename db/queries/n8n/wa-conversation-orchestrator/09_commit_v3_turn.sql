-- Atomically apply the immutable decision's state mutations and exact delivery
-- intent. Replays return the original message without reapplying mutations.
WITH execution_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('v3-decision:' || $1::TEXT, 0))
), target AS MATERIALIZED (
  SELECT execution.*, decision.output_payload, event.processing_token,
         conversation.qualification_context AS state_before,
         conversation.lead_id, conversation.phone_number, number.instance_name
  FROM conversation_turn_executions execution
  JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
  JOIN inbound_events event ON event.id = execution.inbound_event_id
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  LEFT JOIN whatsapp_numbers number ON number.id = conversation.source_number_id
  CROSS JOIN execution_lock
  WHERE execution.decision_id = $1::TEXT
    AND event.processing_token = $2::TEXT
    AND execution.expected_snapshot_digest = $3::TEXT
    AND decision.output_payload->>'version' = 'validated_conversation_decision/v3'
    AND decision.output_payload->>'decision_id' = execution.decision_id
    AND decision.output_payload->>'expected_snapshot_digest' = execution.expected_snapshot_digest
    AND decision.output_payload#>>'{reply,delivery_key}' = execution.delivery_key
    AND (
      execution.state <> 'ready_to_commit'
      OR conversation.qualification_context = execution.expected_snapshot
    )
  FOR UPDATE OF execution, decision, event, conversation
), mutated AS (
  UPDATE conversations conversation
  SET qualification_context = apply_v3_state_mutations(
        target.state_before,
        COALESCE(target.output_payload->'state_mutations', '[]'::JSONB)
      ),
      updated_at = NOW()
  FROM target
  WHERE conversation.id = target.conversation_id
    AND target.state = 'ready_to_commit'
  RETURNING conversation.id, target.id AS execution_id,
            target.state_before, conversation.qualification_context AS state_after
), outbox AS (
  INSERT INTO messages (
    conversation_id, lead_id, direction, message_type, delivery_status,
    text_body, raw_payload, provider_instance_name, idempotency_key,
    inbound_event_id, dispatch_phase, dispatch_token, claimed_at
  )
  SELECT target.conversation_id, target.lead_id, 'outgoing', 'text', 'queued',
         target.output_payload#>>'{reply,text}',
         jsonb_build_object(
           'number', target.phone_number,
           'version', 'validated_conversation_decision/v3',
           'decision_id', target.decision_id,
           'reply_sha256', target.output_payload#>>'{reply,sha256}'
         ),
         target.instance_name, target.delivery_key, target.inbound_event_id,
         'claimed', md5(random()::TEXT || clock_timestamp()::TEXT || target.delivery_key), NOW()
  FROM target
  JOIN mutated ON mutated.execution_id = target.id
  ON CONFLICT (idempotency_key)
    WHERE direction = 'outgoing' AND idempotency_key IS NOT NULL AND deleted_at IS NULL
  DO NOTHING
  RETURNING *
), fixed_message AS MATERIALIZED (
  SELECT message.* FROM outbox message
  UNION ALL
  SELECT message.*
  FROM messages message
  JOIN target ON target.delivery_key = message.idempotency_key
  WHERE message.direction = 'outgoing' AND message.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM outbox)
), committed AS (
  UPDATE conversation_turn_executions execution
  SET state = 'delivery_pending',
      delivery_message_id = fixed_message.id,
      state_receipt = jsonb_build_object(
        'schema', 'conversation_state_receipt/v3',
        'decision_id', target.decision_id,
        'snapshot_digest', target.expected_snapshot_digest,
        'state_before', mutated.state_before,
        'state_after', mutated.state_after
      ),
      updated_at = NOW()
  FROM target
  JOIN mutated ON mutated.execution_id = target.id
  CROSS JOIN fixed_message
  WHERE execution.id = target.id
  RETURNING execution.*
), audit_insert AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id, result,
    before_payload, after_payload, metadata
  )
  SELECT 'v3_turn_committed', 'conversation_turn_execution', target.id,
         'system', 'v3-saga', 'success', mutated.state_before, mutated.state_after,
         jsonb_build_object(
           'decision_id', target.decision_id,
           'delivery_key', target.delivery_key,
           'delivery_message_id', fixed_message.id
         )
  FROM target
  JOIN mutated ON mutated.execution_id = target.id
  CROSS JOIN fixed_message
  RETURNING id
), result_execution AS MATERIALIZED (
  SELECT committed.*, FALSE AS replayed FROM committed
  UNION ALL
  SELECT execution.*, TRUE AS replayed
  FROM conversation_turn_executions execution
  JOIN target ON target.id = execution.id
  WHERE target.state IN ('delivery_pending', 'delivered')
)
SELECT result_execution.*, fixed_message.text_body, fixed_message.raw_payload,
       fixed_message.dispatch_token
FROM result_execution
JOIN fixed_message ON fixed_message.id = result_execution.delivery_message_id;
