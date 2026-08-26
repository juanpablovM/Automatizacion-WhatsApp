-- Attach an immutable authorized decision to the previously fixed route.
-- Replays with the same identities return the existing row unchanged.
WITH locked AS (
  SELECT execution.id
  FROM conversation_turn_executions execution
  WHERE execution.inbound_event_id = $1::BIGINT
  FOR UPDATE
), prepared AS (
  UPDATE conversation_turn_executions execution
  SET advisor_decision_id = $2::BIGINT,
      decision_id = $3::TEXT,
      state = $4::TEXT,
      policy_digest = $5::TEXT,
      proposal_digest = $6::TEXT,
      decision_digest = $7::TEXT,
      delivery_key = $8::TEXT,
      attempt = GREATEST(execution.attempt, 1),
      updated_at = NOW()
  FROM locked
  WHERE execution.id = locked.id
    AND execution.state = 'routed'
    AND execution.decision_id IS NULL
    AND $4::TEXT IN ('prepared', 'effects_pending', 'ready_to_commit')
  RETURNING execution.*
)
SELECT execution.*,
  execution.decision_id = $3::TEXT
    AND execution.policy_digest = $5::TEXT
    AND execution.proposal_digest = $6::TEXT
    AND execution.decision_digest = $7::TEXT
    AND execution.delivery_key = $8::TEXT AS decision_matches
FROM conversation_turn_executions execution
WHERE execution.inbound_event_id = $1::BIGINT;
