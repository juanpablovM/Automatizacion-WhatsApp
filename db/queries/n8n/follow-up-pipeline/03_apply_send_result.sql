-- =============================================================================
-- 03_apply_send_result.sql — Registra el resultado del envio de un follow_up.
-- Nodo n8n: "Apply Follow-Up Result" (OPS - Follow-Up Scheduler).
-- -----------------------------------------------------------------------------
-- Transiciones (patron de las unidades previas, todo auditado):
--   sent     -> estado='sent', sent_at, delivery_log += {result}; idempotente:
--               si ya estaba 'sent', devuelve 'already_sent' sin re-aplicar.
--   failed   -> send_attempt_count+1 y estado='error' con next_retry_at
--               (backoff 10s * 2^(intentos-1), cap a max_send_attempts);
--               al agotar intentos queda 'error' con send_exhausted=true.
--   skipped  -> solo delivery_log (scheduler decidio no emitir: opt-out/otra
--               condicion); estado no cambia.
--
-- Params:
--   :follow_up_id   id reclamado (claim_token valida que sea el mismo tick)
--   :claim_token    token del claim (requerido para all transitions)
--   :outcome        'sent' | 'failed' | 'skipped'
--   :error          mensaje de error (cuando outcome='failed')
-- =============================================================================
WITH target AS (
  SELECT f.id, f.estado, f.send_attempt_count, f.max_send_attempts, f.opted_out, f.claim_token
  FROM follow_ups f
  WHERE f.id = :follow_up_id::bigint AND f.deleted_at IS NULL
),
authorized AS (
  SELECT t.*
  FROM target t
  WHERE t.claim_token IS NOT NULL
    AND t.claim_token::text = :origin_token::text
),
outcome_resolution AS (
  SELECT
    a.id,
    a.estado,
    a.send_attempt_count AS attempts,
    a.max_send_attempts,
    CASE
      WHEN a.id IS NULL THEN 'follow_up_missing'
      WHEN a.claim_token IS NULL THEN 'authorization_missing'
      WHEN a.estado = 'sent' THEN 'already_sent'
      WHEN :outcome::text = 'sent' THEN 'sent'
      WHEN :outcome::text = 'skipped' THEN 'skipped'
      WHEN a.send_attempt_count + 1 >= a.max_send_attempts THEN 'send_exhausted'
      ELSE 'retry'
    END AS result
  FROM authorized a
),
apply AS (
  UPDATE follow_ups f
  SET
    estado = CASE
      WHEN o.result = 'sent' THEN 'sent'
      WHEN o.result IN ('retry', 'send_exhausted') THEN 'error'
      ELSE f.estado
    END,
    result = CASE
      WHEN o.result = 'sent' THEN COALESCE(f.result, 'no_response')
      ELSE f.result
    END,
    sent_at = CASE
      WHEN o.result = 'sent' AND f.sent_at IS NULL THEN NOW()
      ELSE f.sent_at
    END,
    send_attempt_count = CASE
      WHEN o.result IN ('sent', 'retry', 'send_exhausted')
        THEN f.send_attempt_count + 1
      ELSE f.send_attempt_count
    END,
    next_retry_at = CASE
      WHEN o.result = 'retry' THEN NOW() + (10 * (2 ^ f.send_attempt_count)) * INTERVAL '1 second'
      ELSE f.next_retry_at
    END,
    last_send_error = CASE
      WHEN o.result IN ('retry', 'send_exhausted') THEN NULLIF(:error::text, '')
      ELSE f.last_send_error
    END,
    delivery_log = CASE
      WHEN o.result = 'skipped'
        THEN f.delivery_log || jsonb_build_object(
               'at', NOW(), 'status', 'skipped',
               'reason', COALESCE(NULLIF(:error::text, ''), 'window_not_applicable'))
      ELSE f.delivery_log || jsonb_build_object(
               'at', NOW(), 'status', o.result,
               'error', NULLIF(:error::text, ''))
    END,
    updated_at = NOW()
  FROM outcome_resolution o
  WHERE f.id = o.id
    AND o.result IN ('sent', 'skipped', 'retry', 'send_exhausted')
  RETURNING f.id, f.estado, f.send_attempt_count
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'follow_up_send',
    'follow_up',
    o.id,
    'system',
    'ops-follow-up-scheduler',
    o.result,
    jsonb_build_object('estado', o.estado, 'send_attempt_count', o.attempts),
    jsonb_build_object(
      'estado', COALESCE(a.estado, o.estado),
      'send_attempt_count', COALESCE(a.send_attempt_count, o.attempts),
      'error', NULLIF(:error::text, '')
    ),
    jsonb_build_object('outcome', :outcome::text)
  FROM outcome_resolution o
  LEFT JOIN apply a ON a.id = o.id
  WHERE o.id IS NOT NULL
  RETURNING 1
)
SELECT
  COALESCE(a.id, o.id) AS follow_up_id,
  COALESCE(a.estado, o.estado) AS follow_up_estado,
  COALESCE(a.send_attempt_count, o.attempts) AS send_attempt_count,
  o.result
FROM outcome_resolution o
LEFT JOIN apply a ON a.id = o.id;