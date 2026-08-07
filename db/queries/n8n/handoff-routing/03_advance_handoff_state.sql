-- =============================================================================
-- 03_advance_handoff_state.sql — Avance operativo del ciclo de vida.
-- -----------------------------------------------------------------------------
-- Transiciones validas del handoff (Unidad 3):
--   pending -> notified   (02_apply_notification_attempt.sql, solo al exito)
--   notified -> acknowledged   (el area confirma la recepcion)
--   notified|acknowledged -> resolved   (el caso quedo resuelto)
-- Cualquier otra transicion se rechaza y queda auditada como
-- 'invalid_transition' (el gate de no-cierre depende de este contrato).
--
-- Params:
--   :handoff_id   id del handoff
--   :estado       'acknowledged' | 'resolved'
-- =============================================================================
WITH target AS (
  SELECT h.id, h.estado
  FROM handoffs h
  WHERE h.id = :handoff_id::bigint AND h.deleted_at IS NULL
),
valid AS (
  SELECT
    t.id,
    t.estado AS before_estado,
    CASE
      WHEN :estado::text = 'acknowledged' AND t.estado = 'notified' THEN TRUE
      WHEN :estado::text = 'resolved' AND t.estado IN ('notified', 'acknowledged') THEN TRUE
      ELSE FALSE
    END AS allowed
  FROM target t
),
apply AS (
  UPDATE handoffs h
  SET
    estado = :estado::text,
    acknowledged_at = CASE WHEN :estado::text = 'acknowledged' AND h.acknowledged_at IS NULL THEN NOW() ELSE h.acknowledged_at END,
    resolved_at = CASE WHEN :estado::text = 'resolved' AND h.resolved_at IS NULL THEN NOW() ELSE h.resolved_at END,
    updated_at = NOW()
  FROM valid v
  WHERE h.id = v.id AND v.allowed
  RETURNING h.id, h.estado
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_transition',
    'handoff',
    v.id,
    'system',
    'handoff-routing',
    CASE WHEN v.allowed THEN 'advanced' ELSE 'invalid_transition' END,
    jsonb_build_object('estado', v.before_estado),
    jsonb_build_object('estado', COALESCE(a.estado, v.before_estado)),
    jsonb_build_object('requested', :estado::text)
  FROM valid v
  LEFT JOIN apply a ON a.id = v.id
  WHERE v.id IS NOT NULL
  RETURNING 1
)
SELECT
  COALESCE(a.id, v.id) AS handoff_id,
  COALESCE(a.estado, v.before_estado) AS handoff_estado,
  CASE WHEN a.id IS NULL THEN 'invalid_transition' ELSE 'advanced' END AS outcome
FROM valid v
LEFT JOIN apply a ON a.id = v.id;