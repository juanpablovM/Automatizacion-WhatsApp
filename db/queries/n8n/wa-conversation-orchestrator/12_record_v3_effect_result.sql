-- Persist one provider outcome with its exact claim token, then advance the
-- ledger only from durable receipts. Unknown outcomes enter reconciliation.
WITH target AS MATERIALIZED (
  SELECT operation.*
  FROM external_operations operation
  WHERE operation.operation_key = $1::TEXT
    AND operation.request_payload#>>'{v3,payload_digest}' = $2::TEXT
    AND operation.request_payload#>>'{v3,claim_token}' = $3::TEXT
    AND operation.status = 'processing'
  FOR UPDATE
), recorded AS (
  UPDATE external_operations operation
  SET status = CASE $4::TEXT
        WHEN 'succeeded' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        WHEN 'unknown' THEN 'unknown'
      END,
      external_id = NULLIF($6::TEXT, ''),
      response_payload = COALESCE($5::JSONB, '{}'::JSONB),
      completed_at = CASE WHEN $4::TEXT IN ('succeeded', 'failed') THEN NOW() END,
      last_error = NULLIF($7::TEXT, ''),
      reconciliation_required = $4::TEXT = 'unknown',
      reconciliation_reason = CASE WHEN $4::TEXT = 'unknown' THEN COALESCE(NULLIF($7::TEXT, ''), 'ambiguous_effect_outcome') END,
      retry_safe = FALSE,
      updated_at = NOW()
  FROM target
  WHERE operation.id = target.id
    AND $4::TEXT IN ('succeeded', 'failed', 'unknown')
    AND (
      $4::TEXT <> 'succeeded'
      OR (
        $5::JSONB->>'version' = 'v3_effect_receipt/v1'
        AND $5::JSONB->>'operation_key' = target.operation_key
        AND $5::JSONB->>'payload_digest' = target.request_payload#>>'{v3,payload_digest}'
        AND $5::JSONB->>'effect_type' = target.operation_type
        AND $5::JSONB->>'status' = 'succeeded'
        AND (
          (target.operation_type = 'create_lead' AND NULLIF($5::JSONB->>'lead_id', '') IS NOT NULL)
          OR (
            target.operation_type = 'handoff'
            AND NULLIF($5::JSONB->>'handoff_id', '') IS NOT NULL
            AND NOT ($5::JSONB ? 'id')
          )
        )
      )
    )
  RETURNING operation.*
), receipt AS MATERIALIZED (
  SELECT CASE
    WHEN recorded.status = 'succeeded' THEN
      COALESCE($5::JSONB, '{}'::JSONB) || jsonb_build_object('recorded_at', recorded.updated_at)
    ELSE jsonb_build_object(
      'version', 'v3_effect_receipt/v1',
      'operation_key', recorded.operation_key,
      'payload_digest', recorded.request_payload#>>'{v3,payload_digest}',
      'effect_type', recorded.operation_type,
      'status', recorded.status,
      'error', NULLIF($7::TEXT, ''),
      'recorded_at', recorded.updated_at
    )
  END AS value,
  recorded.request_payload#>>'{v3,decision_id}' AS decision_id,
  recorded.status
  FROM recorded
), execution_update AS (
  UPDATE conversation_turn_executions execution
  SET effect_receipt_refs = CASE
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(execution.effect_receipt_refs) item
          WHERE item->>'operation_key' = $1::TEXT
        ) THEN execution.effect_receipt_refs
        ELSE execution.effect_receipt_refs || jsonb_build_array(receipt.value)
      END,
      state = CASE
        WHEN receipt.status = 'unknown' THEN 'reconciliation_required'
        WHEN receipt.status = 'failed' THEN 'aborted'
        WHEN NOT EXISTS (
          SELECT 1
          FROM advisor_decisions decision
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(decision.output_payload->'effect_commands', '[]'::JSONB)
          ) command(value)
          WHERE decision.id = execution.advisor_decision_id
            AND COALESCE((command.value->>'required_before_reply')::BOOLEAN, FALSE)
            AND NOT EXISTS (
              SELECT 1 FROM recorded current_operation
              WHERE current_operation.operation_key = command.value->>'operation_key'
                AND current_operation.status = 'succeeded'
                AND current_operation.request_payload#>>'{v3,payload_digest}' = command.value->>'payload_digest'
            )
            AND NOT EXISTS (
              SELECT 1 FROM external_operations operation
              WHERE operation.operation_key = command.value->>'operation_key'
                AND operation.status = 'succeeded'
                AND operation.request_payload#>>'{v3,payload_digest}' = command.value->>'payload_digest'
            )
        ) THEN 'ready_to_commit'
        ELSE 'effects_pending'
      END,
      last_error = CASE
        WHEN receipt.status IN ('unknown', 'failed')
          THEN jsonb_build_object('code', COALESCE(NULLIF($7::TEXT, ''), receipt.status || '_effect'))
        ELSE NULL
      END,
      updated_at = NOW()
  FROM receipt
  WHERE execution.decision_id = receipt.decision_id
    AND execution.state IN ('effects_pending', 'reconciliation_required')
  RETURNING execution.*
)
SELECT recorded.*, execution_update.state AS execution_state,
       execution_update.effect_receipt_refs, execution_update.last_error,
       decision.output_payload AS v3_decision
FROM recorded
JOIN execution_update
  ON execution_update.decision_id = recorded.request_payload#>>'{v3,decision_id}'
JOIN advisor_decisions decision ON decision.id = execution_update.advisor_decision_id;
