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
), diagnostic AS MATERIALIZED (
  -- n8n prunes executions after about two days, so this is the only durable
  -- record of why the turn fell back. The node already reduces it to codes and
  -- scalars; this re-checks every field, so a free-form value (customer text,
  -- a raw proposal, a provider message) is dropped instead of persisted. The
  -- recovery reason is read from the decision itself, which is authoritative.
  SELECT
    $4::JSONB#>>'{effect_commands,0,payload,recovery_reason}' AS recovery_reason,
    COALESCE((
      SELECT jsonb_agg(codes.code ORDER BY codes.first_position)
      FROM (
        SELECT item.value AS code, MIN(item.position) AS first_position
        FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(input.value->'validation_error_codes') = 'array'
            THEN input.value->'validation_error_codes'
          ELSE '[]'::JSONB
        END) WITH ORDINALITY item(value, position)
        WHERE jsonb_typeof(item.value) = 'string'
          AND item.value#>>'{}' ~ '^[A-Za-z0-9_.:-]{1,64}$'
        GROUP BY item.value
        ORDER BY MIN(item.position)
        LIMIT 20
      ) codes
    ), '[]'::JSONB) AS validation_error_codes,
    CASE WHEN jsonb_typeof(input.value->'ai_fallback_reason') = 'string'
        AND input.value->>'ai_fallback_reason' ~ '^[A-Za-z0-9_.:-]{1,64}$'
      THEN input.value->>'ai_fallback_reason' END AS ai_fallback_reason,
    CASE WHEN jsonb_typeof(input.value->'ai_status_code') = 'number'
        AND input.value->>'ai_status_code' ~ '^[0-9]{3}$'
        AND (input.value->>'ai_status_code')::INT BETWEEN 100 AND 599
      THEN (input.value->>'ai_status_code')::INT END AS ai_status_code,
    CASE WHEN jsonb_typeof(input.value->'repair_attempt') = 'number'
        AND input.value->>'repair_attempt' ~ '^[0-9]{1,3}$'
        AND (input.value->>'repair_attempt')::INT <= 100
      THEN (input.value->>'repair_attempt')::INT END AS repair_attempt
  FROM (SELECT COALESCE($5::JSONB, '{}'::JSONB) AS value) input
), advisor AS (
  INSERT INTO advisor_decisions (
    conversation_id, decision_type, input_payload, output_payload,
    validation_result, validation_errors
  )
  SELECT target.conversation_id, 'v3_system_contingency', $3::JSONB, $4::JSONB,
         'fallback',
         jsonb_build_array('v3_recovery_contingency') || diagnostic.validation_error_codes
  FROM target
  CROSS JOIN diagnostic
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
      last_error = jsonb_build_object(
        'code', 'v3_contingency_selected',
        'recovery_reason', diagnostic.recovery_reason,
        'validation_error_codes', diagnostic.validation_error_codes,
        'ai_fallback_reason', diagnostic.ai_fallback_reason,
        'ai_status_code', diagnostic.ai_status_code,
        'repair_attempt', diagnostic.repair_attempt
      ),
      updated_at = NOW()
  FROM target
  CROSS JOIN advisor
  CROSS JOIN diagnostic
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
