-- Technical-sheet documents to send after a delivered v3.1 reply (task 3c.29).
-- Each send_technical_sheet effect of the decision reserved one document
-- message (19_persist_v3_technical_sheet_effect.sql) and receipted it in
-- effect_receipt_refs. They are released only once the turn reply itself was
-- delivered (execution state 'delivered'), in effect order, so the customer
-- reads the announcement before the PDF. A reply that failed, is unknown or
-- was cancelled by human control releases no document. Each row is the input
-- of one WA - Outbound Messages run, which claims the reserved row by its
-- delivery key; a replay finds it already sent and sends nothing.
--
-- Params: p1 decision_id.
SELECT
  message.id AS document_message_id,
  message.conversation_id,
  message.lead_id,
  message.raw_payload->>'number' AS phone_number,
  message.provider_instance_name AS instance_name,
  message.idempotency_key AS delivery_key,
  'document' AS message_type,
  'technical_sheet' AS response_kind,
  FALSE AS human_arbitration_required,
  execution.decision_id
FROM conversation_turn_executions execution
JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(execution.effect_receipt_refs) = 'array'
    THEN execution.effect_receipt_refs ELSE '[]'::JSONB END
) WITH ORDINALITY receipt(value, position)
JOIN messages message
  ON message.id::TEXT = receipt.value->>'document_message_id'
 AND message.idempotency_key = receipt.value->>'delivery_key'
 AND message.conversation_id = execution.conversation_id
 AND message.direction = 'outgoing'
 AND message.sender_type = 'bot'
 AND message.message_type = 'document'
 AND message.deleted_at IS NULL
WHERE execution.decision_id = $1::TEXT
  AND execution.state = 'delivered'
  AND decision.output_payload->>'version' = 'validated_conversation_decision/v3.1'
  AND receipt.value->>'effect_type' = 'send_technical_sheet'
  AND receipt.value->>'status' = 'succeeded'
ORDER BY receipt.position;
