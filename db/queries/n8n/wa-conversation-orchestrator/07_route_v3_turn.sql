-- Fix one v3 route per inbound event. Conflicting retries return route_matches=false;
-- callers must stop rather than change contract version or mode mid-turn.
WITH inserted AS (
  INSERT INTO conversation_turn_executions (
    inbound_event_id,
    conversation_id,
    contract_version,
    route_mode,
    route_rule_id,
    conversation_revision_expected,
    expected_snapshot_digest
  ) VALUES ($1::BIGINT, $2::BIGINT, 'v3', $3::TEXT, $4::TEXT, $5::BIGINT, $6::TEXT)
  ON CONFLICT (inbound_event_id) DO NOTHING
  RETURNING *
), fixed AS (
  SELECT * FROM inserted
  UNION ALL
  SELECT execution.*
  FROM conversation_turn_executions execution
  WHERE execution.inbound_event_id = $1::BIGINT
    AND NOT EXISTS (SELECT 1 FROM inserted)
)
SELECT fixed.*,
  fixed.contract_version = 'v3'
    AND fixed.route_mode = $3::TEXT
    AND fixed.route_rule_id = $4::TEXT AS route_matches
FROM fixed;
