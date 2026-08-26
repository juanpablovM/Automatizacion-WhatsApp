-- Commit boundary interface for Work Unit 1. Saga wiring supplies the already
-- authorized state receipt and exact delivery intent in Work Unit 2.
WITH eligible AS (
  SELECT execution.id
  FROM conversation_turn_executions execution
  JOIN inbound_events event ON event.id = execution.inbound_event_id
  WHERE execution.decision_id = $1::TEXT
    AND execution.state = 'ready_to_commit'
    AND event.processing_token = $2::TEXT
    AND execution.expected_snapshot_digest = $3::TEXT
  FOR UPDATE OF execution, event
), committed AS (
  UPDATE conversation_turn_executions execution
  SET state = 'committed',
      state_receipt = $4::JSONB,
      updated_at = NOW()
  FROM eligible
  WHERE execution.id = eligible.id
  RETURNING execution.*
)
SELECT committed.* FROM committed;
