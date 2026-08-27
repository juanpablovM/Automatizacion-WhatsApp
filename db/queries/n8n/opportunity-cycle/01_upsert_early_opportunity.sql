-- =============================================================================
-- 01_upsert_early_opportunity.sql — Nace/madura la oportunidad de la
-- conversacion (ciclo A-001). Nodo n8n: "Upsert Early Opportunity".
-- -----------------------------------------------------------------------------
-- Idempotente por conversacion: el indice unico parcial uq_opportunities_conver
-- sation garantiza una sola oportunidad activa por conversacion. En cada turno
-- el mismo enunciado enriquece la oportunidad y la promueve a 'qualified'
-- cuando el gate comercial quedo limpio y el cliente confirmo; un replay del
-- dispatch (recovery) no duplica filas y deja traza en audit_logs.
--
-- Params:
--   :phone_number        contacto
--   :source_number_id    linea de whatsapp (opcional)
--   :conversation_id     conversacion (clave de idempotencia)
--   :external_contact_id id externo de Evolution (opcional)
--   :whatsapp_name       nombre visible (opcional)
--   :service, :city, :requirement  campos comerciales en curso (opcional)
--   :intent_code         intencion del turno (opcional)
--   :inbound_event_id    evento inbound que origina/actualiza (opcional)
--   :should_write        false -> intencion operativa/contexto invalido, no escribe
--   :requested_status    'qualified' solo si gate limpio + confirmado; si no 'new'
-- =============================================================================
WITH input_payload AS (
  SELECT
    :phone_number::text AS phone_number,
    NULLIF(:source_number_id::text, '')::bigint AS source_number_id,
    :conversation_id::bigint AS conversation_id,
    NULLIF(:external_contact_id::text, '') AS external_contact_id,
    NULLIF(:whatsapp_name::text, '') AS whatsapp_name,
    NULLIF(:service::text, '') AS service,
    NULLIF(:city::text, '') AS city,
    NULLIF(:requirement::text, '') AS requirement,
    NULLIF(:intent_code::text, '') AS intent_code,
    NULLIF(:inbound_event_id::text, '')::bigint AS inbound_event_id,
    :should_write::boolean AS should_write,
    :requested_status::text AS requested_status
),
existing AS MATERIALIZED (
  SELECT o.id, o.status_code, o.updated_at
  FROM input_payload ip
  JOIN opportunities o ON o.conversation_id = ip.conversation_id
  WHERE o.deleted_at IS NULL
),
written AS (
  INSERT INTO opportunities (
    phone_number, source_number_id, conversation_id, external_contact_id,
    whatsapp_name, service, city, requirement, intent_code, status_code,
    inbound_event_id
  )
  SELECT
    ip.phone_number, ip.source_number_id, ip.conversation_id, ip.external_contact_id,
    ip.whatsapp_name, ip.service, ip.city, ip.requirement, ip.intent_code,
    ip.requested_status, ip.inbound_event_id
  FROM input_payload ip
  WHERE ip.should_write
  ON CONFLICT (conversation_id) WHERE deleted_at IS NULL
  DO UPDATE SET
    service = COALESCE(EXCLUDED.service, opportunities.service),
    city = COALESCE(EXCLUDED.city, opportunities.city),
    requirement = COALESCE(EXCLUDED.requirement, opportunities.requirement),
    intent_code = COALESCE(EXCLUDED.intent_code, opportunities.intent_code),
    inbound_event_id = COALESCE(EXCLUDED.inbound_event_id, opportunities.inbound_event_id),
    status_code = CASE
      WHEN opportunities.status_code = 'new' AND EXCLUDED.status_code = 'qualified'
        THEN 'qualified'
      ELSE opportunities.status_code
    END,
    updated_at = NOW()
  RETURNING id, status_code
),
write_outcome AS (
  SELECT
    ip.conversation_id,
    COALESCE(w.id, e.id) AS opportunity_id,
    COALESCE(w.status_code, e.status_code) AS opportunity_status,
    CASE
      WHEN NOT ip.should_write THEN 'skipped'
      WHEN e.id IS NULL THEN 'created'
      WHEN w.status_code = 'qualified' AND e.status_code = 'new' THEN 'promoted_qualified'
      WHEN w.status_code = e.status_code THEN 'duplicate_skipped'
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
    'opportunity_sync',
    'opportunity',
    wo.opportunity_id,
    'system',
    'wa-inbound-downstream-dispatcher',
    wo.outcome,
    CASE WHEN e.id IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('status_code', e.status_code) END,
    jsonb_build_object('id', wo.opportunity_id, 'status_code', wo.opportunity_status),
    jsonb_build_object('conversation_id', wo.conversation_id, 'inbound_event_id', ip.inbound_event_id)
  FROM input_payload ip
  JOIN write_outcome wo ON TRUE
  LEFT JOIN existing e ON TRUE
  WHERE ip.should_write
  RETURNING 1
)
SELECT
  wo.opportunity_id,
  wo.opportunity_status,
  wo.outcome
FROM write_outcome wo;
