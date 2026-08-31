-- Claim one authorized blocking effect by stable operation key and payload digest.
-- Unknown/processing outcomes never become executable without reconciliation.
WITH operation_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('v3-effect:' || $2::TEXT, 0))
), command AS MATERIALIZED (
  SELECT execution.id AS execution_id,
         execution.decision_id,
         execution.conversation_id,
         conversation.qualification_context,
         conversation.source_number_id,
         conversation.phone_number,
         event.id AS inbound_event_id,
         COALESCE(event.normalized_payload->>'whatsapp_name', event.raw_payload#>>'{data,pushName}') AS whatsapp_name,
         COALESCE(event.normalized_payload->>'external_contact_id', event.raw_payload#>>'{data,key,remoteJid}') AS external_contact_id,
         decision.output_payload AS v3_decision,
         effect.value AS effect
  FROM conversation_turn_executions execution
  JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  JOIN inbound_events event ON event.id = execution.inbound_event_id
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(decision.output_payload->'effect_commands', '[]'::JSONB)
  ) effect(value)
  CROSS JOIN operation_lock
  WHERE execution.decision_id = $1::TEXT
    AND execution.state IN ('effects_pending', 'reconciliation_required')
    AND effect.value->>'operation_key' = $2::TEXT
    AND effect.value->>'type' = $3::TEXT
    AND effect.value->>'type' IN ('create_lead', 'handoff')
    AND effect.value->'payload' = $4::JSONB
    AND effect.value->>'payload_digest' = $5::TEXT
    AND COALESCE((effect.value->>'required_before_reply')::BOOLEAN, FALSE)
), existing AS MATERIALIZED (
  SELECT operation.*
  FROM external_operations operation
  JOIN command ON command.decision_id = operation.request_payload#>>'{v3,decision_id}'
  WHERE operation.operation_key = $2::TEXT
    AND operation.request_payload#>>'{v3,payload_digest}' = $5::TEXT
  FOR UPDATE
), inserted AS (
  INSERT INTO external_operations (
    operation_key, operation_type, entity_type, entity_id, status,
    attempt_count, locked_at, request_payload, response_payload,
    reconciliation_required, retry_safe
  )
  SELECT $2::TEXT, $3::TEXT, 'conversation_turn_execution', command.execution_id,
         'processing', 1, NOW(),
         jsonb_build_object(
           'payload', $4::JSONB,
           'v3', jsonb_build_object(
             'decision_id', command.decision_id,
             'payload_digest', $5::TEXT,
             'claim_token', md5(random()::TEXT || clock_timestamp()::TEXT || $2::TEXT)
           )
         ),
         '{}'::JSONB, FALSE, FALSE
  FROM command
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING *
), reclaimed AS (
  UPDATE external_operations operation
  SET status = 'processing',
      attempt_count = operation.attempt_count + 1,
      locked_at = NOW(),
      request_payload = jsonb_set(
        operation.request_payload,
        '{v3,claim_token}',
        to_jsonb(md5(random()::TEXT || clock_timestamp()::TEXT || operation.operation_key))
      ),
      response_payload = jsonb_set(operation.response_payload, '{reconciliation,consumed}', 'true'::JSONB),
      reconciliation_required = FALSE,
      retry_safe = FALSE,
      last_error = NULL,
      updated_at = NOW()
  FROM existing
  WHERE operation.id = existing.id
    AND existing.status = 'failed'
    AND existing.retry_safe = TRUE
    AND existing.reconciliation_required = FALSE
    AND existing.response_payload#>>'{reconciliation,resolution}' = 'no_effect_proven'
    AND COALESCE((existing.response_payload#>>'{reconciliation,consumed}')::BOOLEAN, FALSE) = FALSE
  RETURNING operation.*
), fixed AS (
  SELECT inserted.*, TRUE AS should_execute FROM inserted
  UNION ALL
  SELECT reclaimed.*, TRUE AS should_execute FROM reclaimed
  UNION ALL
  SELECT existing.*, FALSE AS should_execute FROM existing
  WHERE NOT EXISTS (SELECT 1 FROM reclaimed)
)
SELECT fixed.*,
       fixed.request_payload#>>'{v3,claim_token}' AS claim_token,
       command.conversation_id,
       command.qualification_context,
       command.source_number_id,
       command.phone_number,
       command.inbound_event_id,
       command.whatsapp_name,
       command.external_contact_id,
       command.effect AS v3_effect_command,
       command.v3_decision,
       TRUE AS operation_matches
FROM fixed
JOIN command ON command.execution_id = fixed.entity_id;
