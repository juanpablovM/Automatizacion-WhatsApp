-- Atomically establish the v3 turn authority before any AI work. The stable
-- source-number plus customer-phone identity serializes conversation creation,
-- ledger acquisition and incoming evidence persistence.
WITH input AS MATERIALIZED (
  SELECT
    $1::BIGINT AS inbound_event_id,
    $2::TEXT AS processing_token,
    NULLIF($3::TEXT, '')::BIGINT AS requested_conversation_id,
    $4::BIGINT AS source_number_id,
    $5::TEXT AS phone_number,
    $6::TEXT AS route_mode,
    $7::TEXT AS route_rule_id,
    COALESCE(NULLIF($8::TEXT, ''), 'service') AS current_step,
    COALESCE(NULLIF($9::TEXT, ''), 'unknown') AS message_type,
    NULLIF($10::TEXT, '') AS external_message_id,
    NULLIF($11::TEXT, '')::TIMESTAMPTZ AS external_timestamp,
    NULLIF($12::TEXT, '') AS text_body,
    COALESCE($13::JSONB, '{}'::JSONB) AS raw_payload
), valid_claim AS MATERIALIZED (
  SELECT event.id
  FROM inbound_events event
  JOIN input ON event.id = input.inbound_event_id
  WHERE event.processing_status = 'processing'
    AND event.processing_token = input.processing_token
    AND event.source_number_id = input.source_number_id
    AND event.phone_number = input.phone_number
    AND input.route_mode IN ('canary', 'enforce')
    AND NULLIF(input.route_rule_id, '') IS NOT NULL
), identity_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended(
    'v3-turn:' || input.source_number_id::TEXT || ':' || input.phone_number,
    0
  ))
  FROM input
  JOIN valid_claim ON TRUE
), existing_execution AS MATERIALIZED (
  SELECT execution.*
  FROM conversation_turn_executions execution
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  JOIN input ON execution.inbound_event_id = input.inbound_event_id
  CROSS JOIN identity_lock
  WHERE conversation.source_number_id = input.source_number_id
    AND conversation.phone_number = input.phone_number
    AND conversation.deleted_at IS NULL
), existing_conversation AS MATERIALIZED (
  SELECT conversation.*
  FROM conversations conversation
  JOIN input ON conversation.source_number_id = input.source_number_id
    AND conversation.phone_number = input.phone_number
  LEFT JOIN existing_execution ON TRUE
  CROSS JOIN identity_lock
  WHERE conversation.deleted_at IS NULL
  ORDER BY
    CASE
      WHEN conversation.id = existing_execution.conversation_id THEN 0
      WHEN conversation.id = input.requested_conversation_id THEN 1
      ELSE 2
    END,
    conversation.started_at DESC,
    conversation.id DESC
  LIMIT 1
), created_conversation AS (
  INSERT INTO conversations (
    source_number_id, phone_number, conversation_status_id, current_step,
    qualification_context, started_at, last_message_at
  )
  SELECT input.source_number_id, input.phone_number, status.id,
         input.current_step, '{}'::JSONB, NOW(), NOW()
  FROM input
  JOIN valid_claim ON TRUE
  CROSS JOIN identity_lock
  JOIN conversation_statuses status ON status.code = 'active'
  WHERE NOT EXISTS (SELECT 1 FROM existing_conversation)
    AND NOT EXISTS (SELECT 1 FROM existing_execution)
  RETURNING *
), resolved_conversation AS MATERIALIZED (
  SELECT existing_conversation.* FROM existing_conversation
  UNION ALL
  SELECT created_conversation.* FROM created_conversation
), inserted_execution AS (
  INSERT INTO conversation_turn_executions (
    inbound_event_id, conversation_id, contract_version, route_mode,
    route_rule_id, conversation_revision_expected, expected_snapshot
  )
  SELECT input.inbound_event_id, conversation.id, 'v3', input.route_mode,
         input.route_rule_id, 0, COALESCE(conversation.qualification_context, '{}'::JSONB)
  FROM input
  JOIN valid_claim ON TRUE
  CROSS JOIN resolved_conversation conversation
  WHERE NOT EXISTS (SELECT 1 FROM existing_execution)
    AND NOT EXISTS (
      SELECT 1
      FROM conversation_turn_executions active
      WHERE active.conversation_id = conversation.id
        AND active.state NOT IN ('delivered', 'aborted')
    )
  ON CONFLICT DO NOTHING
  RETURNING *
), fixed_execution AS MATERIALIZED (
  SELECT inserted_execution.*, TRUE AS route_acquired, FALSE AS replayed
  FROM inserted_execution
  UNION ALL
  SELECT existing_execution.*, FALSE AS route_acquired, TRUE AS replayed
  FROM existing_execution
), matching_execution AS MATERIALIZED (
  SELECT execution.*,
    execution.contract_version = 'v3'
      AND execution.route_mode = input.route_mode
      AND execution.route_rule_id = input.route_rule_id
      AND execution.conversation_id = conversation.id AS route_matches
  FROM fixed_execution execution
  JOIN input ON TRUE
  JOIN resolved_conversation conversation ON conversation.id = execution.conversation_id
), inserted_incoming AS (
  INSERT INTO messages (
    conversation_id, lead_id, direction, message_type, external_message_id,
    external_timestamp, delivery_status, text_body, raw_payload, inbound_event_id
  )
  SELECT execution.conversation_id, conversation.lead_id, 'incoming',
         input.message_type, input.external_message_id, input.external_timestamp,
         NULL, input.text_body, input.raw_payload, input.inbound_event_id
  FROM matching_execution execution
  JOIN input ON TRUE
  JOIN resolved_conversation conversation ON conversation.id = execution.conversation_id
  WHERE execution.route_matches
  ON CONFLICT (inbound_event_id)
    WHERE inbound_event_id IS NOT NULL AND direction = 'incoming' AND deleted_at IS NULL
  DO NOTHING
  RETURNING id, conversation_id, inbound_event_id
), fixed_incoming AS MATERIALIZED (
  SELECT inserted_incoming.* FROM inserted_incoming
  UNION ALL
  SELECT message.id, message.conversation_id, message.inbound_event_id
  FROM messages message
  JOIN input ON message.inbound_event_id = input.inbound_event_id
  WHERE message.direction = 'incoming'
    AND message.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inserted_incoming)
)
SELECT
  input.inbound_event_id,
  input.processing_token,
  input.source_number_id,
  input.phone_number,
  conversation.id AS conversation_id,
  conversation.lead_id,
  conversation.current_step,
  COALESCE(conversation.qualification_context, '{}'::JSONB) AS qualification_context,
  incoming.id AS incoming_message_id,
  execution.id,
  execution.contract_version,
  execution.route_mode,
  execution.route_rule_id,
  execution.state,
  COALESCE(execution.route_acquired, FALSE) AS route_acquired,
  COALESCE(execution.replayed, FALSE) AS replayed,
  COALESCE(execution.route_matches, FALSE) AS route_matches,
  EXISTS (SELECT 1 FROM valid_claim) AS claim_valid,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM valid_claim) THEN 'invalid_claim'
    WHEN execution.id IS NULL THEN 'active_turn_exists'
    WHEN NOT execution.route_matches THEN 'route_conflict'
    ELSE NULL
  END AS route_failure_reason
FROM input
LEFT JOIN resolved_conversation conversation ON TRUE
LEFT JOIN matching_execution execution ON TRUE
LEFT JOIN fixed_incoming incoming
  ON incoming.inbound_event_id = input.inbound_event_id
  AND incoming.conversation_id = execution.conversation_id;
