-- Fix one v3 route per inbound event and serialize active turns per conversation.
WITH conversation_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('v3-turn:' || $2::TEXT, 0))
), existing AS MATERIALIZED (
  SELECT execution.*
  FROM conversation_turn_executions execution
  CROSS JOIN conversation_lock
  WHERE execution.inbound_event_id = $1::BIGINT
), inserted AS (
  INSERT INTO conversation_turn_executions (
    inbound_event_id,
    conversation_id,
    contract_version,
    route_mode,
    route_rule_id,
    conversation_revision_expected,
    expected_snapshot_digest,
    expected_snapshot
  )
  SELECT $1::BIGINT, $2::BIGINT, 'v3', $3::TEXT, $4::TEXT, $5::BIGINT,
         $6::TEXT, $7::JSONB
  FROM conversation_lock
  WHERE NOT EXISTS (SELECT 1 FROM existing)
    AND NOT EXISTS (
      SELECT 1 FROM conversation_turn_executions active
      WHERE active.conversation_id = $2::BIGINT
        AND active.state NOT IN ('delivered', 'aborted')
    )
  ON CONFLICT (conversation_id)
    WHERE state NOT IN ('delivered', 'aborted')
  DO NOTHING
  RETURNING *
), fixed AS (
  SELECT inserted.*, TRUE AS route_acquired, FALSE AS replayed FROM inserted
  UNION ALL
  SELECT existing.*, FALSE AS route_acquired, TRUE AS replayed FROM existing
)
SELECT fixed.*,
  fixed.contract_version = 'v3'
    AND fixed.route_mode = $3::TEXT
    AND fixed.route_rule_id = $4::TEXT
    AND fixed.conversation_id = $2::BIGINT
    AND fixed.expected_snapshot_digest = $6::TEXT
    AND fixed.expected_snapshot = $7::JSONB AS route_matches
FROM fixed;
