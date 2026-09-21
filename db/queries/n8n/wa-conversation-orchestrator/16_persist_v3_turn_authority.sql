-- Attach the immutable authorized decision to the route, conversation and
-- incoming evidence that were durably fixed before the AI request.
WITH request_context AS MATERIALIZED (
  SELECT $4::BIGINT AS source_number_id,
         $5::TEXT AS phone_number,
         $6::TEXT AS message_type,
         $7::TEXT AS external_message_id,
         $8::TEXT AS text_body,
         $9::JSONB AS raw_payload,
         $10::TEXT AS current_step
), target AS MATERIALIZED (
  SELECT execution.*, incoming.id AS incoming_message_id
  FROM conversation_turn_executions execution
  JOIN inbound_events event ON event.id = execution.inbound_event_id
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  JOIN messages incoming ON incoming.inbound_event_id = execution.inbound_event_id
    AND incoming.conversation_id = execution.conversation_id
    AND incoming.direction = 'incoming'
    AND incoming.deleted_at IS NULL
  JOIN request_context ON conversation.source_number_id = request_context.source_number_id
    AND conversation.phone_number = request_context.phone_number
  WHERE execution.inbound_event_id = $1::BIGINT
    AND event.processing_status = 'processing'
    AND event.processing_token = $2::TEXT
    AND execution.conversation_id = $3::BIGINT
    AND execution.state = 'routed'
    AND execution.decision_id IS NULL
    AND $12::JSONB->>'version' = 'ai_prd_turn_policy/v3'
    AND $14::JSONB->>'version' = 'conversation_validation_result/v3'
    AND COALESCE(($14::JSONB->>'valid')::BOOLEAN, FALSE)
    AND $15::JSONB->>'version' = 'validated_conversation_decision/v3'
    AND $15::JSONB->>'decision_id' = $11::TEXT
    AND $15::JSONB->>'conversation_id' = execution.conversation_id::TEXT
    AND $15::JSONB->>'turn_id' = execution.inbound_event_id::TEXT
    AND $15::JSONB->>'policy_digest' = $12::JSONB->>'policy_digest'
    AND $15::JSONB->>'policy_digest' = $14::JSONB->>'policy_digest'
    AND $15::JSONB->>'proposal_digest' = $14::JSONB->>'proposal_digest'
    AND $15::JSONB->>'expected_snapshot_digest' IS NOT NULL
    AND $15::JSONB#>>'{reply,delivery_key}' IS NOT NULL
    AND NULLIF($18::TEXT, '') IS NOT NULL
  FOR UPDATE OF execution, event, conversation, incoming
), existing_advisor AS MATERIALIZED (
  SELECT decision.*
  FROM advisor_decisions decision
  JOIN target ON target.conversation_id = decision.conversation_id
  WHERE decision.decision_type = 'conversation_v3_authorized'
    AND decision.output_payload->>'decision_id' = $11::TEXT
  ORDER BY decision.id DESC
  LIMIT 1
), inserted_advisor AS (
  INSERT INTO advisor_decisions (
    conversation_id, message_id, decision_type, ai_provider, ai_model,
    input_payload, output_payload, validation_result, validation_errors
  )
  SELECT target.conversation_id, target.incoming_message_id,
         'conversation_v3_authorized', NULLIF($16::TEXT, ''), NULLIF($17::TEXT, ''),
         jsonb_build_object(
           'policy', $12::JSONB,
           'proposal', $13::JSONB,
           'validation', $14::JSONB
         ),
         $15::JSONB, 'accepted', '[]'::JSONB
  FROM target
  WHERE NOT EXISTS (SELECT 1 FROM existing_advisor)
  RETURNING *
), fixed_advisor AS MATERIALIZED (
  SELECT inserted_advisor.* FROM inserted_advisor
  UNION ALL
  SELECT existing_advisor.* FROM existing_advisor
), attached AS (
  UPDATE conversation_turn_executions execution
  SET advisor_decision_id = advisor.id,
      decision_id = $11::TEXT,
      state = CASE
        WHEN jsonb_array_length(COALESCE($15::JSONB->'effect_commands', '[]'::JSONB)) > 0
          THEN 'effects_pending'
        ELSE 'ready_to_commit'
      END,
      conversation_revision_expected = ($15::JSONB->>'conversation_revision_expected')::BIGINT,
      expected_snapshot_digest = $15::JSONB->>'expected_snapshot_digest',
      policy_digest = $15::JSONB->>'policy_digest',
      proposal_digest = $15::JSONB->>'proposal_digest',
      decision_digest = $18::TEXT,
      delivery_key = $15::JSONB#>>'{reply,delivery_key}',
      attempt = GREATEST(execution.attempt, 1),
      updated_at = NOW()
  FROM target
  CROSS JOIN fixed_advisor advisor
  WHERE execution.id = target.id
  RETURNING execution.*
), fixed_execution AS MATERIALIZED (
  SELECT attached.*, FALSE AS replayed FROM attached
  UNION ALL
  SELECT execution.*, TRUE AS replayed
  FROM conversation_turn_executions execution
  WHERE execution.inbound_event_id = $1::BIGINT
    AND execution.decision_id = $11::TEXT
    AND NOT EXISTS (SELECT 1 FROM attached)
)
SELECT execution.*,
  execution.advisor_decision_id IS NOT NULL
    AND execution.decision_id = $11::TEXT
    AND execution.policy_digest = $15::JSONB->>'policy_digest'
    AND execution.proposal_digest = $15::JSONB->>'proposal_digest'
    AND execution.decision_digest = $18::TEXT
    AND execution.delivery_key = $15::JSONB#>>'{reply,delivery_key}'
    AND execution.state IN ('effects_pending', 'ready_to_commit', 'delivery_pending', 'delivered')
    AS decision_matches
FROM fixed_execution execution;
