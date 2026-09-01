-- Close a v3 execution only from the provider result persisted on its exact
-- outbox message. The reply bytes, decision, delivery key and provider id must
-- all agree; any mismatch returns no row and fails closed.
WITH target AS MATERIALIZED (
  SELECT execution.*, decision.output_payload, message.delivery_status,
         message.external_message_id, message.text_body, message.idempotency_key,
         encode(sha256(convert_to(message.text_body, 'UTF8')), 'hex') AS reply_sha256
  FROM conversation_turn_executions execution
  JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
  JOIN messages message ON message.id = execution.delivery_message_id
  WHERE execution.decision_id = $1::TEXT
    AND execution.delivery_message_id = $2::BIGINT
    AND execution.delivery_key = $5::TEXT
    AND execution.state IN ('delivery_pending', 'delivered', 'reconciliation_required')
    AND message.direction = 'outgoing'
    AND message.idempotency_key = execution.delivery_key
    AND message.delivery_status = $3::TEXT
    AND $3::TEXT IN ('sent', 'failed', 'unknown')
    AND decision.output_payload->>'decision_id' = execution.decision_id
    AND decision.output_payload#>>'{reply,delivery_key}' = execution.delivery_key
    AND decision.output_payload#>>'{reply,text}' = message.text_body
    AND decision.output_payload#>>'{reply,sha256}' =
        encode(sha256(convert_to(message.text_body, 'UTF8')), 'hex')
    AND (
      ($3::TEXT = 'sent'
        AND NULLIF($4::TEXT, '') IS NOT NULL
        AND message.external_message_id = NULLIF($4::TEXT, ''))
      OR ($3::TEXT IN ('failed', 'unknown'))
    )
  FOR UPDATE OF execution, decision, message
), receipt AS MATERIALIZED (
  SELECT jsonb_build_object(
    'schema', 'v3_delivery_receipt/v1',
    'decision_id', target.decision_id,
    'delivery_message_id', target.delivery_message_id,
    'delivery_key', target.delivery_key,
    'provider_message_id', target.external_message_id,
    'delivery_status', target.delivery_status,
    'delivered_bytes_sha256', target.reply_sha256
  ) AS value
  FROM target
), transitioned AS (
  UPDATE conversation_turn_executions execution
  SET state = CASE
        WHEN target.delivery_status = 'sent' THEN 'delivered'
        ELSE 'reconciliation_required'
      END,
      delivery_receipt_ref = receipt.value,
      last_error = CASE
        WHEN target.delivery_status = 'sent' THEN NULL
        ELSE jsonb_build_object(
          'code', 'v3_delivery_provider_outcome',
          'delivery_status', target.delivery_status,
          'delivery_message_id', target.delivery_message_id,
          'delivery_key', target.delivery_key
        )
      END,
      updated_at = NOW()
  FROM target
  CROSS JOIN receipt
  WHERE execution.id = target.id
    AND target.state = 'delivery_pending'
  RETURNING execution.*
), audit_insert AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
  )
  SELECT 'v3_delivery_recorded', 'conversation_turn_execution', transitioned.id,
         'system', 'wa-inbound-downstream-dispatcher',
         CASE WHEN transitioned.state = 'delivered' THEN 'success' ELSE 'reconciliation_required' END,
         jsonb_build_object(
           'decision_id', transitioned.decision_id,
           'delivery_message_id', transitioned.delivery_message_id,
           'delivery_receipt_ref', transitioned.delivery_receipt_ref,
           -- The WHERE above admits only `delivery_pending`, so the lifecycle
           -- audit can name both ends of the move it just made.
           'from_state', 'delivery_pending',
           'to_state', transitioned.state
         )
  FROM transitioned
  RETURNING id
), result_execution AS MATERIALIZED (
  SELECT transitioned.*, FALSE AS replayed FROM transitioned
  UNION ALL
  SELECT execution.*, TRUE AS replayed
  FROM conversation_turn_executions execution
  JOIN target ON target.id = execution.id
  CROSS JOIN receipt
  WHERE execution.state IN ('delivered', 'reconciliation_required')
    AND execution.delivery_receipt_ref = receipt.value
)
SELECT result_execution.*, receipt.value AS v3_delivery_receipt,
       target.text_body, target.idempotency_key AS delivery_key,
       target.external_message_id AS provider_external_message_id,
       target.delivery_status
FROM result_execution
CROSS JOIN target
CROSS JOIN receipt;
