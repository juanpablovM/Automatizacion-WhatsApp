-- Persist the system-authored contingency as a new immutable decision before
-- its handoff effect or copy can be released.
WITH target AS MATERIALIZED (
  SELECT execution.*
  FROM conversation_turn_executions execution
  JOIN inbound_events event ON event.id = execution.inbound_event_id
  WHERE execution.inbound_event_id = $1::BIGINT
    AND event.processing_token = $2::TEXT
    AND execution.state = 'routed'
    AND execution.decision_id IS NULL
    AND $3::JSONB->>'version' = 'ai_prd_turn_policy/v3'
    AND $4::JSONB->>'version' = 'system_contingency_decision/v3'
    AND $4::JSONB->>'policy_digest' = $3::JSONB->>'policy_digest'
    AND $4::JSONB->'state_mutations' = '[]'::JSONB
  FOR UPDATE OF execution, event
), advisor AS (
  INSERT INTO advisor_decisions (
    conversation_id, decision_type, input_payload, output_payload,
    validation_result, validation_errors
  )
  SELECT target.conversation_id, 'v3_system_contingency', $3::JSONB, $4::JSONB,
         'fallback', jsonb_build_array('v3_recovery_contingency')
  FROM target
  RETURNING *
), prepared AS (
  UPDATE conversation_turn_executions execution
  SET advisor_decision_id = advisor.id,
      decision_id = $4::JSONB->>'decision_id',
      state = 'prepared',
      expected_snapshot_digest = $4::JSONB->>'expected_snapshot_digest',
      policy_digest = $4::JSONB->>'policy_digest',
      proposal_digest = NULL,
      decision_digest = $4::JSONB->>'decision_digest',
      delivery_key = $4::JSONB#>>'{reply,delivery_key}',
      attempt = execution.attempt + 1,
      last_error = jsonb_build_object('code', 'v3_contingency_selected'),
      updated_at = NOW()
  FROM target
  CROSS JOIN advisor
  WHERE execution.id = target.id
  RETURNING execution.*
), fixed AS (
  SELECT prepared.*, FALSE AS replayed FROM prepared
  UNION ALL
  SELECT execution.*, TRUE AS replayed
  FROM conversation_turn_executions execution
  WHERE execution.inbound_event_id = $1::BIGINT
    AND execution.decision_id = $4::JSONB->>'decision_id'
    AND NOT EXISTS (SELECT 1 FROM prepared)
)
SELECT fixed.*,
       fixed.policy_digest = $4::JSONB->>'policy_digest'
         AND fixed.delivery_key = $4::JSONB#>>'{reply,delivery_key}'
         AND fixed.state IN ('prepared', 'delivery_pending', 'delivered') AS decision_matches
FROM fixed;
