-- =============================================================================
-- 01_upsert_handoff.sql — Registro durable del escalamiento (Unidad 3).
-- Nodo n8n: "Upsert Escalation Handoff" (WA - Inbound Downstream Dispatcher).
-- -----------------------------------------------------------------------------
-- Idempotente por idempotency_key `{conversation_id}:{motivo}:{trigger}`:
-- el indice unico parcial uq_handoffs_idempotency garantiza una sola fila
-- activa por evento. Un replay del dispatch (recovery) o un reintento con el
-- mismo motivo NO duplica y deja traza en audit_logs como 'duplicate_skipped'.
-- El estado del handoff (pending/notified/acknowledged/resolved) nunca se
-- degrada en un upsert posterior.
--
-- Params:
-- Params posicionales n8n Postgres v2: $1..$15 (ver queryReplacement del workflow).
-- =============================================================================
WITH input_payload AS (
  SELECT
    $1::boolean AS should_write,
    $2::bigint AS conversation_id,
    $3::text AS phone_number,
    NULLIF($4::text, '')::bigint AS source_number_id,
    NULLIF($5::text, '')::bigint AS inbound_event_id,
    $6::text AS motivo,
    $7::text AS area,
    $8::text AS area_label,
    $9::text AS prioridad,
    $10::text AS responsable,
    $11::text AS idempotency_key,
    NULLIF($12::text, '') AS trigger,
    NULLIF($13::text, '') AS escalation_reason,
    NULLIF($14::text, '') AS escalation_area,
    NULLIF($15::text, '') AS intent
),
existing AS MATERIALIZED (
  SELECT h.id, h.estado, h.notification_attempt_count
  FROM input_payload ip
  JOIN handoffs h ON h.idempotency_key = ip.idempotency_key
  WHERE h.deleted_at IS NULL
),
written AS (
  INSERT INTO handoffs (
    idempotency_key, conversation_id, phone_number, source_number_id,
    inbound_event_id, motivo, area, area_label, prioridad, responsable,
    trigger, escalation_reason, escalation_area, intent, estado
  )
  SELECT
    ip.idempotency_key, ip.conversation_id, ip.phone_number, ip.source_number_id,
    ip.inbound_event_id, ip.motivo, ip.area, ip.area_label, ip.prioridad,
    ip.responsable, ip.trigger, ip.escalation_reason, ip.escalation_area,
    ip.intent, 'pending'
  FROM input_payload ip
  WHERE ip.should_write
  ON CONFLICT (idempotency_key) WHERE deleted_at IS NULL
  DO UPDATE SET
    motivo = EXCLUDED.motivo,
    area = EXCLUDED.area,
    area_label = EXCLUDED.area_label,
    prioridad = EXCLUDED.prioridad,
    responsable = EXCLUDED.responsable,
    trigger = COALESCE(EXCLUDED.trigger, handoffs.trigger),
    escalation_reason = COALESCE(EXCLUDED.escalation_reason, handoffs.escalation_reason),
    escalation_area = COALESCE(EXCLUDED.escalation_area, handoffs.escalation_area),
    intent = COALESCE(EXCLUDED.intent, handoffs.intent),
    updated_at = NOW()
  RETURNING id, estado
),
write_outcome AS (
  SELECT
    ip.conversation_id,
    COALESCE(w.id, e.id) AS handoff_id,
    COALESCE(w.estado, e.estado) AS handoff_estado,
    CASE
      WHEN NOT ip.should_write THEN 'skipped'
      WHEN e.id IS NULL THEN 'created'
      WHEN w.id IS NOT NULL AND w.estado = 'pending' THEN 'duplicate_skipped'
      ELSE 'updated'
    END AS outcome
  FROM input_payload ip
  LEFT JOIN existing e ON TRUE
  LEFT JOIN written w ON TRUE
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_sync',
    'handoff',
    wo.handoff_id,
    'system',
    'wa-inbound-downstream-dispatcher',
    wo.outcome,
    CASE WHEN e.id IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('estado', e.estado,
                                 'notification_attempt_count', e.notification_attempt_count) END,
    jsonb_build_object('id', wo.handoff_id, 'estado', wo.handoff_estado,
                       'motivo', ip.motivo, 'area', ip.area,
                       'prioridad', ip.prioridad, 'responsable', ip.responsable),
    jsonb_build_object('conversation_id', wo.conversation_id,
                       'idempotency_key', ip.idempotency_key,
                       'inbound_event_id', ip.inbound_event_id)
  FROM input_payload ip
  JOIN write_outcome wo ON TRUE
  LEFT JOIN existing e ON TRUE
  WHERE ip.should_write
  RETURNING 1
)
SELECT
  wo.handoff_id,
  wo.handoff_estado,
  wo.outcome
FROM write_outcome wo;
