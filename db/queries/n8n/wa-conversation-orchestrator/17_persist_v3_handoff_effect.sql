-- Execute one authorized normal handoff from its exact external-operation
-- claim. The contingency-only internal_handoff type is intentionally excluded.
WITH target AS MATERIALIZED (
  SELECT operation.*, execution.decision_id, execution.inbound_event_id,
         conversation.id AS conversation_id, conversation.phone_number,
         conversation.source_number_id
  FROM external_operations operation
  JOIN conversation_turn_executions execution
    ON operation.entity_type = 'conversation_turn_execution'
   AND operation.entity_id = execution.id
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  WHERE operation.operation_key = $1::TEXT
    AND operation.operation_type = 'handoff'
    AND operation.status = 'processing'
    AND operation.request_payload#>>'{v3,decision_id}' = $2::TEXT
    AND operation.request_payload#>>'{v3,payload_digest}' = $3::TEXT
    AND operation.request_payload#>>'{v3,claim_token}' = $4::TEXT
  FOR UPDATE OF operation, execution, conversation
), inserted AS (
  INSERT INTO handoffs (
    idempotency_key, conversation_id, phone_number, source_number_id,
    inbound_event_id, motivo, area, area_label, prioridad, responsable,
    trigger, escalation_reason, escalation_area, intent, metadata
  )
  SELECT target.operation_key, target.conversation_id, target.phone_number,
         target.source_number_id, target.inbound_event_id,
         'v3_authorized_handoff', 'sales', 'Ventas', 'alta', 'Equipo Ventas',
         'v3_effect', 'v3_authorized_handoff', 'sales', 'v3_handoff',
         jsonb_build_object(
           'decision_id', target.decision_id,
           'payload_digest', $3::TEXT,
           'effect_payload', target.request_payload->'payload'
         )
  FROM target
  ON CONFLICT (idempotency_key) WHERE deleted_at IS NULL DO NOTHING
  RETURNING *
), fixed AS MATERIALIZED (
  SELECT inserted.* FROM inserted
  UNION ALL
  SELECT handoff.*
  FROM handoffs handoff
  JOIN target ON target.operation_key = handoff.idempotency_key
  WHERE handoff.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inserted)
)
SELECT
  target.operation_key,
  target.operation_type,
  $3::TEXT AS payload_digest,
  $4::TEXT AS claim_token,
  fixed.id AS handoff_id,
  jsonb_build_object(
    'version', 'v3_effect_receipt/v1',
    'operation_key', target.operation_key,
    'payload_digest', $3::TEXT,
    'effect_type', 'handoff',
    'status', 'succeeded',
    'handoff_id', fixed.id
  ) AS v3_effect_receipt
FROM target
CROSS JOIN fixed;
