-- Atomically apply the immutable decision's state mutations and exact delivery
-- intent. Replays return the original message without reapplying mutations.
WITH execution_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('v3-decision:' || $1::TEXT, 0))
), target AS MATERIALIZED (
  SELECT execution.*, decision.output_payload, decision.input_payload AS advisor_input_payload, event.processing_token,
         event.received_at AS turn_received_at,
         conversation.qualification_context AS state_before,
         conversation.lead_id, conversation.phone_number, number.instance_name,
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             COALESCE(execution.effect_receipt_refs, '[]'::JSONB)
           ) receipt(value)
           WHERE receipt.value->>'effect_type' = 'create_lead'
             AND receipt.value->>'status' = 'succeeded'
             AND receipt.value->>'lead_id' = conversation.lead_id::TEXT
         ) AS lead_effect_succeeded,
         EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(execution.effect_receipt_refs, '[]'::JSONB)) receipt(value)
           WHERE receipt.value->>'effect_type' = 'handoff' AND receipt.value->>'status' = 'succeeded'
         ) AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(decision.output_payload->'effect_commands', '[]'::JSONB)) command(value)
           WHERE command.value->>'type' = 'handoff'
             AND command.value#>>'{payload,escalation_reason}' = 'no_progress_commercial_question_loop'
         ) AS bounded_handoff_succeeded
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
      conversation_status_id = CASE
        WHEN target.bounded_handoff_succeeded THEN (SELECT status.id FROM conversation_statuses status WHERE status.code = 'escalation_required')
        WHEN target.lead_effect_succeeded THEN (
          SELECT status.id FROM conversation_statuses status
          WHERE status.code = 'handed_to_sales'
        )
        WHEN NULLIF(target.output_payload#>>'{reply,primary_request,goal_id}', '') IS NOT NULL THEN (
          SELECT status.id FROM conversation_statuses status
          WHERE status.code = 'waiting_user'
        )
        ELSE conversation.conversation_status_id
      END,
      current_step = CASE
        WHEN target.bounded_handoff_succeeded THEN 'escalation'
        WHEN target.lead_effect_succeeded THEN 'complete'
        WHEN NULLIF(target.output_payload#>>'{reply,primary_request,goal_id}', '') IS NOT NULL
          THEN CASE target.output_payload#>>'{reply,primary_request,goal_id}'
            WHEN 'final_confirmation' THEN 'confirm'
            ELSE target.output_payload#>>'{reply,primary_request,goal_id}'
          END
        ELSE conversation.current_step
      END,
      pending_question_key = CASE
        WHEN target.bounded_handoff_succeeded THEN NULL
        WHEN target.lead_effect_succeeded THEN NULL
        WHEN NULLIF(target.output_payload#>>'{reply,primary_request,goal_id}', '') IS NOT NULL
          THEN target.output_payload#>>'{reply,primary_request,goal_id}'
        ELSE conversation.pending_question_key
      END,
      handed_to_sales_at = CASE
        WHEN target.lead_effect_succeeded
          THEN COALESCE(conversation.handed_to_sales_at, NOW())
        ELSE conversation.handed_to_sales_at
      END,
      last_message_at = GREATEST(conversation.last_message_at, target.turn_received_at, NOW()),
      updated_at = NOW()
  FROM target
  WHERE conversation.id = target.conversation_id
    AND target.state = 'ready_to_commit'
  RETURNING conversation.id, target.id AS execution_id,
            target.state_before, conversation.qualification_context AS state_after,
            conversation.conversation_status_id AS conversation_status_id_after,
            conversation.current_step AS current_step_after,
            conversation.pending_question_key AS pending_question_key_after
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
           'version', 'validated_conversation_decision/v3',
           'decision_id', target.decision_id,
           'reply_sha256', target.output_payload#>>'{reply,sha256}'
         ),
         target.instance_name, target.delivery_key, target.inbound_event_id,
         'reserved', NULL, NULL
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
           'delivery_message_id', fixed_message.id,
           'conversation_terminalized', target.lead_effect_succeeded,
           'pending_question_key', mutated.pending_question_key_after,
           'commercial_question_retry', CASE
             WHEN mutated.state_before IS DISTINCT FROM mutated.state_after THEN 0
             WHEN mutated.pending_question_key_after = 'address'
               AND target.advisor_input_payload#>>'{policy,turn,pending_question_goal_id}' = 'address'
             THEN COALESCE((
               SELECT CASE WHEN goal.value#>>'{guidance,previous_retry_count}' ~ '^[0-9]{1,6}$'
                 THEN (goal.value#>>'{guidance,previous_retry_count}')::integer ELSE 0 END
               FROM jsonb_array_elements(COALESCE(target.advisor_input_payload#>'{policy,goals}', '[]'::jsonb)) goal(value)
               WHERE goal.value->>'goal_id' = 'address'
               LIMIT 1
             ), 0) + 1
             ELSE 0
           END
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
       fixed_message.raw_payload->>'reply_sha256' AS reply_sha256,
       fixed_message.dispatch_token,
       fixed_message.lead_id,
       lead.service,
       lead.city,
       lead.requirement,
       lead.qualification_context,
       COALESCE(mutated.state_after, conversation.qualification_context) AS v3_persisted_qualification_context,
       COALESCE(mutated.current_step_after, conversation.current_step) AS current_step,
       CASE
         WHEN mutated.execution_id IS NOT NULL THEN mutated.pending_question_key_after
         ELSE conversation.pending_question_key
       END AS pending_question_key,
       status.code AS conversation_status_code,
       COALESCE(mutated.current_step_after, conversation.current_step) AS v3_persisted_current_step,
       CASE
         WHEN mutated.execution_id IS NOT NULL THEN mutated.pending_question_key_after
         ELSE conversation.pending_question_key
       END AS v3_persisted_pending_question_key,
       status.code AS v3_persisted_conversation_status_code
FROM result_execution
JOIN fixed_message ON fixed_message.id = result_execution.delivery_message_id
JOIN conversations conversation ON conversation.id = result_execution.conversation_id
LEFT JOIN mutated ON mutated.execution_id = result_execution.id
JOIN conversation_statuses status
  ON status.id = COALESCE(
    mutated.conversation_status_id_after,
    conversation.conversation_status_id
  )
LEFT JOIN leads lead ON lead.id = fixed_message.lead_id
                    AND lead.deleted_at IS NULL;
