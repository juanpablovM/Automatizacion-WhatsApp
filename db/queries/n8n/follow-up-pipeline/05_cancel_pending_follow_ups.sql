-- =============================================================================
-- 05_cancel_pending_follow_ups.sql — Cancela la cadencia de una conversacion.
-- Nodo n8n: "Cancel Pending Follow Ups" (WA - Inbound Downstream Dispatcher).
-- -----------------------------------------------------------------------------
-- Motivos (PRD #25.4 / estados del agente):
--   client_replied  -> el cliente respondio: ya no hace falta recontacto
--   escalated       -> se derivo a humano: el area toma el caso
--   lost            -> lead perdido o sin interes: lost_reason obligatorio
--   closed          -> el lead se cerro/completo (oportunidad promovida)
--
-- Cancela TODOS los steps pendientes o en envio de la conversacion (los
-- proximos pasos futuros tambien). Los ya 'sent' quedan como historial.
-- Idempotente: no hay pendientes -> devuelve 0 y audita 'already_cancelled'.
--
-- Params:
--   :conversation_id   conversacion a cancelar
--   :cancel_reason     motivo canonico (arriba)
--   :lost_reason       motivo de perdida (si cancel_reason='lost')
--   :lost_step_dia     dia de cadencia en el que se perdio (opcional)
-- =============================================================================
WITH target AS (
  SELECT id, estado FROM follow_ups f
  WHERE f.conversation_id = :conversation_id::bigint
    AND f.deleted_at IS NULL
    AND f.estado IN ('pending', 'sending')
),
cancelled AS (
  UPDATE follow_ups f
  SET estado = 'cancelled',
      result = CASE
        WHEN :cancel_reason::text = 'lost' THEN 'lost'
        ELSE COALESCE(f.result, 'responded')
      END,
      lost_reason = CASE
        WHEN :cancel_reason::text = 'lost' THEN NULLIF(:lost_reason::text, '')
        ELSE f.lost_reason
      END,
      lost_step_dia = NULLIF(:lost_step_dia::text, '')::smallint,
      updated_at = NOW()
  FROM target t
  WHERE f.id = t.id
  RETURNING f.id, f.estado, f.step_dia
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'follow_up_cancelled',
    'follow_up',
    COALESCE((SELECT MIN(c.id) FROM cancelled c), :conversation_id::bigint),
    'system',
    'wa-inbound-downstream-dispatcher',
    CASE WHEN (SELECT COUNT(*) FROM cancelled) > 0 THEN 'cancelled' ELSE 'already_cancelled' END,
    jsonb_build_object('conversation_id', :conversation_id::bigint, 'reason', :cancel_reason::text),
    jsonb_build_object(
      'cancelled', (SELECT COUNT(*) FROM cancelled),
      'lost_reason', NULLIF(:lost_reason::text, ''),
      'lost_step_dia', NULLIF(:lost_step_dia::text, '')::smallint
    ),
    '{}'::JSONB
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM cancelled) AS cancelled_count,
  (SELECT COALESCE(array_agg(step_dia::text), '{}') FROM cancelled) AS cancelled_steps,
  CASE WHEN (SELECT COUNT(*) FROM cancelled) > 0 THEN 'cancelled' ELSE 'already_cancelled' END AS result;