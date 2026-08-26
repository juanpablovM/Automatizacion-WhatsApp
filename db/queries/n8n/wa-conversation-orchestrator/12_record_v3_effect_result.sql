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
  RETURNING operation.*
), receipt AS MATERIALIZED (
  SELECT jsonb_build_object(
    'operation_key', recorded.operation_key,
    'payload_digest', recorded.request_payload#>>'{v3,payload_digest}',
    'status', recorded.status,
    'external_id', recorded.external_id,
    'recorded_at', recorded.updated_at
  ) AS value,
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
       execution_update.effect_receipt_refs, execution_update.last_error
FROM recorded
JOIN execution_update
  ON execution_update.decision_id = recorded.request_payload#>>'{v3,decision_id}';
