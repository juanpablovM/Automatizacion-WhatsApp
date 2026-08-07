-- =============================================================================
-- 02_apply_notification_attempt.sql — Aplica un intento de notificacion.
-- Nodo n8n: "Mark Handoff Attempt" (WA - Inbound Downstream Dispatcher).
-- -----------------------------------------------------------------------------
-- La notificacion al area es verificable exactamente una vez:
--   - success -> estado='notified' y notified_at (una sola vez, idempotente:
--     un replay con estado ya notificado devuelve 'already_notified' sin
--     incrementar intentos ni re-enviar).
--   - fail    -> incrementa notification_attempt_count; mientras queden
--     intentos (max_attempts=3) queda 'retry' para el siguiente dispatch;
--     al agotarlos queda 'notification_exhausted' con el error en
--     last_notification_error. El estado permanece 'pending' y toda la
--     transicion queda en audit_logs.
--
-- Params:
--   :handoff_id   id del handoff a notificar
--   :outcome      'succeeded' | 'failed' (resultado del stub determinista)
--   :error        texto de error cuando falla (opcional)
-- =============================================================================
WITH target AS (
  SELECT h.id, h.estado, h.notification_attempt_count AS attempts, h.max_attempts
  FROM handoffs h
  WHERE h.id = :handoff_id::bigint AND h.deleted_at IS NULL
),
outcome_resolution AS (
  SELECT
    t.id,
    t.estado,
    t.attempts,
    t.max_attempts,
CASE
      WHEN t.id IS NULL THEN 'handoff_missing'
      WHEN t.estado <> 'pending' THEN 'already_notified'
      WHEN t.attempts >= t.max_attempts THEN 'attempt_limit_exceeded'
      WHEN :outcome::text = 'succeeded' THEN 'succeeded'
      WHEN (t.attempts + 1) >= t.max_attempts THEN 'notification_exhausted'
      ELSE 'retry'
    END AS result
  FROM target t
),
apply AS (
  UPDATE handoffs h
  SET
    estado = CASE WHEN o.result = 'succeeded' THEN 'notified' ELSE h.estado END,
    notification_attempt_count = CASE
      WHEN o.result IN ('succeeded', 'retry', 'notification_exhausted')
        THEN h.notification_attempt_count + 1
      ELSE h.notification_attempt_count
    END,
    notified_at = CASE
      WHEN o.result = 'succeeded' AND h.notified_at IS NULL THEN NOW()
      ELSE h.notified_at
    END,
    last_notification_error = CASE
      WHEN o.result IN ('retry', 'notification_exhausted') THEN NULLIF(:error::text, '')
      ELSE h.last_notification_error
    END,
    updated_at = NOW()
  FROM outcome_resolution o
  WHERE h.id = o.id
    AND o.result IN ('succeeded', 'retry', 'notification_exhausted')
  RETURNING h.id, h.estado, h.notification_attempt_count
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_transition',
    'handoff',
    o.id,
    'system',
    'wa-inbound-downstream-dispatcher',
    o.result,
    jsonb_build_object('estado', o.estado, 'notification_attempt_count', o.attempts),
    jsonb_build_object(
      'estado', COALESCE(a.estado, o.estado),
      'notification_attempt_count', COALESCE(a.notification_attempt_count, o.attempts),
      'error', NULLIF(:error::text, '')
    ),
    jsonb_build_object('outcome', :outcome::text, 'channel', 'internal')
  FROM outcome_resolution o
  LEFT JOIN apply a ON a.id = o.id
  WHERE o.id IS NOT NULL
  RETURNING 1
)
SELECT
  COALESCE(a.id, o.id) AS handoff_id,
  COALESCE(a.estado, o.estado) AS handoff_estado,
  COALESCE(a.notification_attempt_count, o.attempts) AS notification_attempt_count,
  o.result
FROM outcome_resolution o
LEFT JOIN apply a ON a.id = o.id;