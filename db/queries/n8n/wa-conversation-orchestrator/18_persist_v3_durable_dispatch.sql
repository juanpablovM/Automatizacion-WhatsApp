-- Persist the exact terminal dispatch contract before any downstream effects.
-- The legacy state writer is deliberately excluded: v3 state/decision/outbox
-- authority has already been committed by the canonical saga.
WITH input AS MATERIALIZED (
  SELECT $1::BIGINT AS inbound_event_id, $2::TEXT AS processing_token,
         $3::JSONB AS payload
), persisted AS (
  UPDATE inbound_events event
  SET downstream_payload = input.payload,
      processing_phase = 'state_persisted', updated_at = NOW()
  FROM input
  JOIN conversation_turn_executions execution
    ON execution.inbound_event_id = input.inbound_event_id
   AND execution.conversation_id::TEXT = input.payload->>'conversation_id'
   AND execution.decision_id = input.payload->>'decision_id'
   AND execution.delivery_key = input.payload->>'delivery_key'
  JOIN messages message ON message.id = execution.delivery_message_id
   AND message.idempotency_key = execution.delivery_key
   AND message.direction = 'outgoing' AND message.sender_type = 'bot'
   AND message.text_body = input.payload->>'response_text'
   AND message.deleted_at IS NULL
  WHERE event.id = input.inbound_event_id
    AND event.processing_status = 'processing'
    AND event.processing_token = input.processing_token
    AND input.payload->>'inbound_event_id' = event.id::TEXT
    AND input.payload->>'processing_token' = event.processing_token
    AND COALESCE((input.payload->>'v3_saga')::BOOLEAN, FALSE)
    AND execution.state IN ('delivery_pending', 'delivered', 'reconciliation_required')
    AND execution.delivery_message_id::TEXT = input.payload->>'delivery_message_id'
    AND (event.downstream_payload = '{}'::JSONB OR event.downstream_payload = input.payload)
  RETURNING event.downstream_payload AS dispatch_payload
)
SELECT CASE WHEN COUNT(*) = 1 THEN jsonb_agg(dispatch_payload)->0
            ELSE to_jsonb(1 / (COUNT(*) - COUNT(*))) END AS dispatch_payload
FROM persisted;
