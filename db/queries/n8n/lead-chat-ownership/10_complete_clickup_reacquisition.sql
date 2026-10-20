-- =============================================================================
-- 10_complete_clickup_reacquisition.sql — Cierra un claim de reacquisicion.
-- -----------------------------------------------------------------------------
-- El claim_token es un CAS: un worker viejo nunca puede cerrar el intento de
-- otro. Los 425/429 vuelven a pending; los resultados ambiguos quedan unknown y
-- se reconcilian despues de un nuevo GET. Ambos se vuelven terminales al agotar
-- el maximo configurado.
--
-- Params:
--   p1 operation_id, p2 operation_claim_token,
--   p3 outcome (succeeded | skipped_ownership_changed | retry | unknown | failed),
--   p4 error_text, p5 observed_clickup_status, p6 response_json,
--   p7 max_attempts (default 5)
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '')::bigint AS operation_id,
    NULLIF($2::text, '')::uuid AS claim_token,
    NULLIF($3::text, '') AS outcome,
    NULLIF($4::text, '') AS error_text,
    NULLIF($5::text, '') AS observed_status,
    COALESCE(NULLIF($6::text, ''), '{}')::jsonb AS response_json,
    GREATEST(COALESCE(NULLIF($7::text, '')::integer, 5), 1) AS max_attempts
),
target AS MATERIALIZED (
  SELECT eo.*
  FROM external_operations eo
  CROSS JOIN input i
  WHERE eo.id = i.operation_id
    AND eo.operation_type = 'clickup_status_reacquire'
    AND eo.entity_type = 'lead_chat_ownership'
  FOR UPDATE OF eo
),
classified AS (
  SELECT
    t.*,
    i.outcome,
    i.error_text,
    i.observed_status,
    i.response_json,
    i.max_attempts,
    CASE
      WHEN t.status = 'processing'
       AND t.claim_token IS NOT NULL
       AND i.claim_token IS NOT NULL
       AND t.claim_token = i.claim_token THEN 'authorized'
      ELSE 'claim_mismatch'
    END AS authorization
  FROM target t
  CROSS JOIN input i
),
applied AS (
  UPDATE external_operations eo
  SET
    status = CASE
      WHEN c.outcome IN ('succeeded', 'skipped_ownership_changed') THEN 'succeeded'
      WHEN c.outcome = 'retry' AND c.attempt_count < c.max_attempts THEN 'pending'
      WHEN c.outcome = 'unknown' AND c.attempt_count < c.max_attempts THEN 'unknown'
      ELSE 'failed'
    END,
    completed_at = CASE
      WHEN c.outcome IN ('succeeded', 'skipped_ownership_changed')
        OR c.outcome = 'failed'
        OR c.attempt_count >= c.max_attempts
        THEN NOW()
      ELSE NULL
    END,
    locked_at = NOW(),
    last_error = CASE
      WHEN c.outcome IN ('succeeded', 'skipped_ownership_changed') THEN NULL
      WHEN c.attempt_count >= c.max_attempts
        THEN COALESCE(c.error_text, 'clickup_reacquire_attempts_exhausted')
      ELSE COALESCE(c.error_text, 'clickup_reacquire_unspecified')
    END,
    response_payload = c.response_json || jsonb_build_object(
      'outcome', c.outcome,
      'observed_clickup_status', c.observed_status
    ),
    retry_safe = c.outcome = 'retry' AND c.attempt_count < c.max_attempts,
    reconciliation_required = c.outcome = 'unknown' AND c.attempt_count < c.max_attempts,
    reconciliation_reason = CASE
      WHEN c.outcome = 'unknown' AND c.attempt_count < c.max_attempts
        THEN COALESCE(c.error_text, 'clickup_reacquire_unconfirmed')
      ELSE NULL
    END,
    claim_token = NULL,
    updated_at = NOW()
  FROM classified c
  WHERE eo.id = c.id
    AND c.authorization = 'authorized'
    AND c.outcome IN (
      'succeeded', 'skipped_ownership_changed', 'retry', 'unknown', 'failed'
    )
  RETURNING eo.*
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_clickup_reacquisition',
    'lead_chat_ownership',
    c.entity_id,
    'system',
    'ops-lead-chat-lease-scheduler',
    CASE WHEN a.id IS NULL THEN c.authorization ELSE a.status END,
    jsonb_build_object(
      'operation_id', c.id,
      'status', c.status,
      'attempt_count', c.attempt_count
    ),
    jsonb_build_object(
      'status', COALESCE(a.status, c.status),
      'outcome', c.outcome,
      'observed_clickup_status', c.observed_status
    ),
    jsonb_build_object('error', c.error_text)
  FROM classified c
  LEFT JOIN applied a ON a.id = c.id
  RETURNING id
)
SELECT
  c.id AS operation_id,
  COALESCE(a.status, c.status) AS operation_status,
  COALESCE(a.attempt_count, c.attempt_count) AS attempt_count,
  CASE
    WHEN c.authorization <> 'authorized' THEN c.authorization
    WHEN a.id IS NULL THEN 'invalid_outcome'
    ELSE 'completed'
  END AS outcome
FROM classified c
LEFT JOIN applied a ON a.id = c.id

UNION ALL

SELECT
  NULL::bigint,
  NULL::text,
  NULL::integer,
  'unknown_operation'
WHERE NOT EXISTS (SELECT 1 FROM classified);
