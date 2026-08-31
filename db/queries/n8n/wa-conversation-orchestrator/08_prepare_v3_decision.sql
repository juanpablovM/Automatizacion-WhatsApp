-- Recover the immutable advisor decision already attached by Persist V3 Turn
-- Authority. This is a read boundary, not a second authority writer.
SELECT
  execution.*,
  decision.output_payload AS v3_decision,
  decision.input_payload->'policy' AS v3_policy,
  TRUE AS decision_matches
FROM conversation_turn_executions execution
JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
WHERE execution.inbound_event_id = $1::BIGINT
  AND execution.decision_id = decision.output_payload->>'decision_id'
  AND decision.output_payload->>'version' = 'validated_conversation_decision/v3'
  AND execution.state IN (
    'effects_pending', 'reconciliation_required', 'ready_to_commit',
    'delivery_pending', 'delivered'
  );
