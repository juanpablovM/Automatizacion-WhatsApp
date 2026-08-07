-- =============================================================================
-- 01_schedule_follow_up.sql — Agenda un step de cadencia (A-010).
-- Nodo n8n: "Schedule Follow Up" (OPS - Follow-Up Scheduler).
-- -----------------------------------------------------------------------------
-- Idempotente: por (conversation_id, step_dia) solo existe UN follow_up activo
-- (pending/sending); si el step ya esta agendado o enviado, el INSERT no hace
-- nada y se devuelve 'duplicate_skipped'. La clave de idempotencia canonica es
-- `{conversation_id}:{step_dia}` (el motivo se agrega a la clave para no
-- permitir dos cadencias distintas sobre el mismo step).
--
-- Params:
--   :conversation_id  conversacion de la cadencia
--   :opportunity_id   oportunidad vinculada (opcional)
--   :phone_number     numero del cliente
--   :source_number_id linea que atendera el envio (opcional)
--   :motivo           motivo canonico (cotizacion_pendiente/lead_sin_respuesta/...)
--   :step_dia         0|1|3|7|14
--   :scheduled_at     momento de la proxima emision (calculado por la fixture)
-- =============================================================================
WITH scheduled AS (
  INSERT INTO follow_ups (
    idempotency_key, conversation_id, opportunity_id, phone_number,
    source_number_id, motivo, step_dia, scheduled_at
  )
  SELECT
    :conversation_id::bigint || ':' || :step_dia::smallint::text,
    :conversation_id::bigint,
    NULLIF(:opportunity_id::text, '')::bigint,
    :phone_number::text,
    NULLIF(:source_number_id::text, '')::bigint,
    :motivo::text,
    :step_dia::smallint,
    :scheduled_at::timestamptz
  WHERE NOT EXISTS (
    SELECT 1 FROM follow_ups f
    WHERE f.conversation_id = :conversation_id::bigint
      AND f.step_dia = :step_dia::smallint
      AND f.deleted_at IS NULL
      AND f.estado IN ('pending', 'sending')
  )
  RETURNING id
),
scheduled_info AS (
  SELECT COUNT(*) AS n FROM scheduled
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'follow_up_step',
    'follow_up',
    COALESCE((SELECT s.id FROM scheduled s LIMIT 1), :conversation_id::bigint * 1000 + :step_dia::smallint),
    'system',
    'ops-follow-up-scheduler',
    CASE WHEN (SELECT n FROM scheduled_info) > 0 THEN 'scheduled' ELSE 'duplicate_skipped' END,
    '{}'::JSONB,
    jsonb_build_object(
      'conversation_id', :conversation_id::bigint,
      'step_dia', :step_dia::smallint,
      'scheduled_at', :scheduled_at::timestamptz
    ),
    '{}'::JSONB
  RETURNING result
)
SELECT
  CASE WHEN (SELECT n FROM scheduled_info) > 0 THEN 'scheduled' ELSE 'duplicate_skipped' END AS result,
  (SELECT n FROM scheduled_info) AS scheduled_count;