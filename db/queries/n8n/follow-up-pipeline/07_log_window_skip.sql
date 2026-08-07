-- =============================================================================
-- 07_log_window_skip.sql — Registra items vencidos fuera de la ventana.
-- Nodo n8n: "Log Out Of Window Follow Ups" (OPS - Follow-Up Scheduler).
-- -----------------------------------------------------------------------------
-- Cada tick ejecuta esta consulta antes/despues del claim: los follow_ups
-- pending vencidos pero fuera de la ventana de envio NO se reclaman (el claim
-- ya los deja pending). Esta consulta los marca como visto (window_skip_at)
-- y deja el evento en audit para trazabilidad (no spamear: solo se actualiza
-- last_window_skip_at si paso mas de una hora desde el ultimo registro).
--
-- Params:
--   :window_start  HH:MM local (default 09:00)
--   :window_end    HH:MM local (default 20:00)
--   :now           reloj del tick
-- =============================================================================
WITH vencidos AS (
  SELECT f.id
  FROM follow_ups f
  WHERE f.deleted_at IS NULL
    AND f.estado = 'pending'
    AND f.opted_out = FALSE
    AND f.scheduled_at <= COALESCE(NULLIF(:now::text, '')::timestamptz, NOW())
    AND (
      COALESCE(NULLIF(:now::text, '')::timestamptz, NOW())::TIME
        < NULLIF(:window_start::text, '')::TIME
      OR COALESCE(NULLIF(:now::text, '')::timestamptz, NOW())::TIME
        > NULLIF(:window_end::text, '')::TIME
    )
),
marked AS (
  UPDATE follow_ups f
  SET last_window_skip_at = NOW(),
      updated_at = NOW()
  FROM vencidos v
  WHERE f.id = v.id
    AND (
      f.last_window_skip_at IS NULL
      OR f.last_window_skip_at < NOW() - INTERVAL '1 hour'
    )
  RETURNING f.id
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'follow_up_skipped_window',
    'follow_up',
    COALESCE((SELECT MIN(m.id) FROM marked m), 0),
    'system',
    'ops-follow-up-scheduler',
    CASE WHEN (SELECT COUNT(*) FROM marked) > 0 THEN 'skipped_window' ELSE 'in_window' END,
    jsonb_build_object(
      'due_outside_window', (SELECT COUNT(*) FROM vencidos),
      'window_start', NULLIF(:window_start::text, ''),
      'window_end', NULLIF(:window_end::text, '')
    ),
    jsonb_build_object('marked', (SELECT COUNT(*) FROM marked)),
    '{}'::JSONB
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM vencidos) AS due_outside_window,
  CASE WHEN (SELECT COUNT(*) FROM marked) > 0 THEN 'skipped_window' ELSE 'in_window' END AS result;