-- Reconcile only by the original operation key and payload digest. A complete
-- zero-match proof creates a single-use retry authorization; inconclusive and
-- duplicate evidence stay quarantined.
WITH target AS MATERIALIZED (
  SELECT operation.*
  FROM external_operations operation
  WHERE operation.operation_key = $1::TEXT
    AND operation.request_payload#>>'{v3,payload_digest}' = $2::TEXT
    AND operation.status = 'unknown'
    AND operation.reconciliation_required = TRUE
  FOR UPDATE
), reconciled AS (
  UPDATE external_operations operation
  SET status = CASE
        WHEN $3::TEXT = 'succeeded' THEN 'succeeded'
        WHEN $3::TEXT = 'no_effect_proven' THEN 'failed'
        ELSE 'unknown'
      END,
      response_payload = operation.response_payload || jsonb_build_object(
        'reconciliation', jsonb_build_object(
          'resolution', $3::TEXT,
          'evidence', $4::JSONB,
          'consumed', FALSE
        )
      ),
      completed_at = CASE WHEN $3::TEXT = 'succeeded' THEN NOW() END,
      reconciliation_required = $3::TEXT IN ('inconclusive', 'duplicate'),
      reconciliation_reason = CASE
        WHEN $3::TEXT = 'inconclusive' THEN 'exact_key_search_inconclusive'
        WHEN $3::TEXT = 'duplicate' THEN 'duplicate_effect_incident'
      END,
      retry_safe = $3::TEXT = 'no_effect_proven',
      last_error = CASE
        WHEN $3::TEXT = 'inconclusive' THEN 'exact_key_search_inconclusive'
        WHEN $3::TEXT = 'duplicate' THEN 'duplicate_effect_incident'
      END,
      updated_at = NOW()
  FROM target
  WHERE operation.id = target.id
    AND $3::TEXT IN ('succeeded', 'no_effect_proven', 'inconclusive', 'duplicate')
  RETURNING operation.*
), execution_update AS (
  UPDATE conversation_turn_executions execution
  SET state = CASE
        WHEN $3::TEXT = 'succeeded' AND NOT EXISTS (
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
        WHEN $3::TEXT IN ('succeeded', 'no_effect_proven') THEN 'effects_pending'
        ELSE 'reconciliation_required'
      END,
      last_error = CASE
        WHEN $3::TEXT = 'duplicate' THEN jsonb_build_object('code', 'duplicate_effect_incident')
        WHEN $3::TEXT = 'inconclusive' THEN jsonb_build_object('code', 'exact_key_search_inconclusive')
        ELSE NULL
      END,
      updated_at = NOW()
  FROM reconciled
  WHERE execution.decision_id = reconciled.request_payload#>>'{v3,decision_id}'
    AND execution.state = 'reconciliation_required'
  RETURNING execution.*
)
SELECT reconciled.*, execution_update.state AS execution_state,
       execution_update.last_error
FROM reconciled
JOIN execution_update
  ON execution_update.decision_id = reconciled.request_payload#>>'{v3,decision_id}';
