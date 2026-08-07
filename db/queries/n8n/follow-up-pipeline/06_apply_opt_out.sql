-- =============================================================================
-- 06_apply_opt_out.sql — Opt-out: el cliente pidio no recibir mas mensajes.
-- Nodo n8n: "Apply Follow-Up Opt-Out" (n - Inbound Downstream Dispatcher).
-- -----------------------------------------------------------------------------
-- Cuando el cliente manifiesta que no le escriban mas (phrases del fixture
-- follow-up-policy.detectOutOut), TODOS los follow_ups pendientes/en envio de
-- la conversacion pasan a estado 'opted_out' y nunca se vuelven a enviar.
-- La cancelacion es definitiva (guardrail PRD: respetar la baja).
--
-- Params:
--   :conversation_id  conversacion a optar fuera
--   :source_text      texto que disparo el opt-out (trazabilidad)
-- =============================================================================
WITH targeted AS (
  SELECT id FROM follow_ups f
  WHERE f.conversation_id = :conversation_id::bigint
    AND f.deleted_at IS NULL
    AND f.estado IN ('pending', 'sending')
),
opted AS (
  UPDATE follow_ups f
  SET estado = 'opted_out',
      opted_out = TRUE,
      result = COALESCE(f.result, 'no_response'),
      last_send_error = NULLIF(:source_text::text, ''),
      updated_at = NOW()
  FROM targeted t
  WHERE f.id = t.id
  RETURNING f.id, f.step_dia
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'follow_up_opt_out',
    'follow_up',
    COALESCE((SELECT MIN(o.id) FROM opted o), :conversation_id::bigint),
    'system',
    'wa-inbound-downstream-dispatcher',
    'opted_out',
    jsonb_build_object('conversation_id', :conversation_id::bigint),
    jsonb_build_object(
      'opted_out', (SELECT COUNT(*) FROM opted),
      'source_text', NULLIF(:source_text::text, '')
    ),
    '{}'::JSONB
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM opted) AS opted_out_count,
  CASE WHEN (SELECT COUNT(*) FROM opted) > 0 THEN 'opted_out' ELSE 'no_pending' END AS result;