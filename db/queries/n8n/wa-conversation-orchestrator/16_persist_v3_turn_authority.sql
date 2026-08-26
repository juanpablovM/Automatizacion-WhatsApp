-- Persist only the structural turn anchor, inbound evidence and immutable v3
-- decision. Commercial state remains untouched until the saga commit.
WITH authority_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('v3-authority:' || $1::TEXT, 0))
), valid_claim AS MATERIALIZED (
  SELECT inbound.id
  FROM inbound_events inbound
  CROSS JOIN authority_lock
  WHERE inbound.id = $1::BIGINT
    AND inbound.processing_status = 'processing'
    AND inbound.processing_token = $2::TEXT
), existing_conversation AS MATERIALIZED (
  SELECT conversation.id
  FROM conversations conversation
  CROSS JOIN valid_claim
  WHERE conversation.id = NULLIF($3::TEXT, '')::BIGINT
    AND conversation.deleted_at IS NULL
), created_conversation AS (
  INSERT INTO conversations (
    source_number_id,
    phone_number,
    conversation_status_id,
    current_step,
    qualification_context,
    started_at,
    last_message_at
  )
  SELECT
    $4::BIGINT,
    $5::TEXT,
    status.id,
    COALESCE(NULLIF($10::TEXT, ''), 'service'),
    '{}'::JSONB,
    NOW(),
    NOW()
  FROM conversation_statuses status
  CROSS JOIN valid_claim
  WHERE status.code = 'active'
    AND NOT EXISTS (SELECT 1 FROM existing_conversation)
  RETURNING id
), resolved_conversation AS MATERIALIZED (
  SELECT id FROM existing_conversation
  UNION ALL
  SELECT id FROM created_conversation
), inserted_incoming_message AS (
  INSERT INTO messages (
    conversation_id,
    direction,
    message_type,
    external_message_id,
    text_body,
    raw_payload,
    inbound_event_id
  )
  SELECT
    conversation.id,
    'incoming',
    COALESCE(NULLIF($6::TEXT, ''), 'unknown'),
    NULLIF($7::TEXT, ''),
    NULLIF($8::TEXT, ''),
    COALESCE(NULLIF($9::TEXT, '')::JSONB, '{}'::JSONB),
    $1::BIGINT
  FROM resolved_conversation conversation
  ON CONFLICT DO NOTHING
  RETURNING id, conversation_id
), incoming_message AS MATERIALIZED (
  SELECT id, conversation_id FROM inserted_incoming_message
  UNION ALL
  SELECT message.id, message.conversation_id
  FROM messages message
  JOIN resolved_conversation conversation ON conversation.id = message.conversation_id
  WHERE message.inbound_event_id = $1::BIGINT
    AND message.direction = 'incoming'
    AND message.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inserted_incoming_message)
), existing_advisor_decision AS MATERIALIZED (
  SELECT decision.id
  FROM advisor_decisions decision
  JOIN resolved_conversation conversation ON conversation.id = decision.conversation_id
  WHERE decision.decision_type = 'conversation_v3_authorized'
    AND decision.output_payload->>'decision_id' = $11::TEXT
  ORDER BY decision.id DESC
  LIMIT 1
), inserted_advisor_decision AS (
  INSERT INTO advisor_decisions (
    conversation_id,
    message_id,
    decision_type,
    ai_provider,
    ai_model,
    input_payload,
    output_payload,
    validation_result,
    validation_errors
  )
  SELECT
    conversation.id,
    message.id,
    'conversation_v3_authorized',
    NULLIF($16::TEXT, ''),
    NULLIF($17::TEXT, ''),
    jsonb_build_object(
      'policy', COALESCE(NULLIF($12::TEXT, '')::JSONB, '{}'::JSONB),
      'proposal', COALESCE(NULLIF($13::TEXT, '')::JSONB, '{}'::JSONB)
    ),
    COALESCE(NULLIF($15::TEXT, '')::JSONB, '{}'::JSONB),
    'accepted',
    '[]'::JSONB
  FROM resolved_conversation conversation
  JOIN incoming_message message ON message.conversation_id = conversation.id
  CROSS JOIN valid_claim
  WHERE NOT EXISTS (SELECT 1 FROM existing_advisor_decision)
    AND COALESCE(NULLIF($14::TEXT, '')::JSONB->>'valid', 'false')::BOOLEAN
  RETURNING id
), advisor_decision AS MATERIALIZED (
  SELECT id FROM existing_advisor_decision
  UNION ALL
  SELECT id FROM inserted_advisor_decision
)
SELECT
  conversation.id AS conversation_id,
  message.id AS incoming_message_id,
  decision.id AS advisor_decision_id,
  TRUE AS v3_authority_persisted
FROM resolved_conversation conversation
JOIN incoming_message message ON message.conversation_id = conversation.id
CROSS JOIN advisor_decision decision;
