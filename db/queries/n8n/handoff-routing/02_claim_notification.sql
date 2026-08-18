-- Claim pending handoffs through external_operations.
-- $1 batch size, $2 stale processing seconds.
WITH stale AS (
  UPDATE external_operations eo
  SET status = 'unknown',
      reconciliation_required = TRUE,
      reconciliation_reason = 'stale_processing_without_provider_result',
      retry_safe = FALSE,
      claim_token = NULL,
      updated_at = NOW()
  WHERE eo.operation_type = 'handoff_clickup_notification'
    AND eo.status = 'processing'
    AND eo.locked_at < NOW() - (COALESCE(NULLIF($2::text, '')::integer, 900) * INTERVAL '1 second')
  RETURNING eo.id
),
candidates AS MATERIALIZED (
  SELECT h.*,
         eo.id AS existing_operation_id,
         eo.status AS existing_operation_status,
         eo.attempt_count AS existing_attempt_count,
         eo.reconciliation_required AS existing_reconciliation_required,
         eo.request_payload AS existing_request_payload
  FROM handoffs h
  LEFT JOIN external_operations eo
    ON eo.operation_key = 'handoff-clickup:' || h.id::text
  WHERE h.deleted_at IS NULL
    AND h.estado = 'pending'
    AND h.next_notification_at <= NOW()
    AND COALESCE(eo.attempt_count, 0) < h.max_attempts
    AND (
      eo.id IS NULL
      OR eo.status = 'pending'
      OR (eo.status = 'failed' AND eo.retry_safe = TRUE AND eo.reconciliation_required = FALSE)
      OR (eo.status = 'unknown' AND eo.reconciliation_required = TRUE
          AND COALESCE(eo.request_payload->>'no_effect_authorization_consumed', 'false') = 'true')
    )
  ORDER BY h.next_notification_at, h.id
  LIMIT COALESCE(NULLIF($1::text, '')::integer, 20)
  FOR UPDATE OF h SKIP LOCKED
),
seeded AS (
  INSERT INTO external_operations (
    operation_key, operation_type, entity_type, entity_id, status,
    attempt_count, locked_at, claim_token, request_payload
  )
  SELECT
    'handoff-clickup:' || c.id::text,
    'handoff_clickup_notification',
    'handoff', c.id, 'processing', 1, NOW(), gen_random_uuid(),
    jsonb_build_object('handoff_id', c.id, 'area', c.area, 'motivo', c.motivo)
  FROM candidates c
  WHERE c.existing_operation_id IS NULL
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING *
),
reclaimed AS (
  UPDATE external_operations eo
  SET status = 'processing',
      attempt_count = eo.attempt_count + 1,
      locked_at = NOW(),
      claim_token = gen_random_uuid(),
      retry_safe = FALSE,
      last_error = NULL,
      updated_at = NOW()
  FROM candidates c
  WHERE eo.id = c.existing_operation_id
    AND (eo.status = 'pending'
      OR (eo.status = 'failed' AND eo.retry_safe = TRUE)
      OR (eo.status = 'unknown' AND eo.reconciliation_required = TRUE
          AND COALESCE(eo.request_payload->>'no_effect_authorization_consumed', 'false') = 'true'))
  RETURNING eo.*
),
claimed AS (
  SELECT * FROM seeded
  UNION ALL
  SELECT * FROM reclaimed
)
SELECT
  h.id AS handoff_id,
  h.conversation_id,
  h.phone_number,
  h.motivo,
  h.area,
  h.area_label,
  h.prioridad,
  h.responsable,
  h.trigger,
  h.escalation_reason,
  h.intent,
  h.idempotency_key,
  h.max_attempts,
  cl.id AS operation_id,
  cl.operation_key,
  cl.attempt_count,
  cl.claim_token,
  cl.reconciliation_required,
  COALESCE(cl.request_payload->>'no_effect_authorization_consumed', 'false') = 'true' AS no_effect_authorization_consumed
FROM claimed cl
JOIN handoffs h ON h.id = cl.entity_id
ORDER BY h.id;
