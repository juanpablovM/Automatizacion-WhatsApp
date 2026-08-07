-- =============================================================================
-- 04_schedule_next_step.sql — Agenda el step siguiente de la cadencia.
-- Nodo n8n: "Schedule Next Follow-Up" (OPS - Follow-Up Scheduler).
-- -----------------------------------------------------------------------------
-- Cuando un step se envio con exito (estado='sent'), la cadencia continua con
-- el proximo step de la serie 0/1/3/7/14. Idempotente como el 01: si el
-- proximo step ya existe activo, no se duplica (duplicate_skipped).
--
-- Params:
--   :conversation_id    conversacion de la cadencia
--   :opportunity_id     oportunidad vinculada (opcional)
--   :phone_number       numero del cliente
--   :source_number_id   linea (opcional)
--   :motivo             mismo motivo de la cadencia
--   :step_dia           paso siguiente (1|3|7|14)
--   :scheduled_at       momento de la proxima emision
--   :previous_id        id del step recien enviado (trazabilidad)
-- =============================================================================
WITH next_step AS (
  INSERT INTO follow_ups (
    idempotency_key, conversation_id, opportunity_id, phone_number,
    source_number_id, motivo, step_dia, scheduled_at, metadata
  )
  SELECT
    :conversation_id::bigint || ':' || :step_dia::smallint::text,
    :conversation_id::bigint,
    NULLIF(:opportunity_id::text, '')::bigint,
    :phone_number::text,
    NULLIF(:source_number_id::text, '')::bigint,
    :motivo::text,
    :step_dia::smallint,
    :scheduled_at::timestamptz,
    jsonb_build_object('previous_follow_up_id', :previous_id::bigint)
  WHERE NOT EXISTS (
    SELECT 1 FROM follow_ups f
    WHERE f.conversation_id = :conversation_id::bigint
      AND f.step_dia = :step_dia::smallint
      AND f.deleted_at IS NULL
      AND f.estado IN ('pending', 'sending')
  )
  RETURNING id, idempotency_key, conversation_id, step_dia, scheduled_at
)
SELECT
  CASE WHEN (SELECT COUNT(*) FROM next_step) > 0
    THEN 'next_scheduled' ELSE 'duplicate_skipped' END AS result,
  (SELECT id FROM next_step LIMIT 1) AS follow_up_id;