-- =============================================================================
-- 02_link_promoted_lead.sql — Vincula la oportunidad al lead creado.
-- Nodo n8n: "Link Opportunity Promotion" (CRM - Lead Creation And Assignment).
-- -----------------------------------------------------------------------------
-- Cuando el pipeline de venta crea el lead (gate limpio + confirmado), la
-- oportunidad de esa conversacion pasa a 'promoted' y queda trazado el lead
-- del que nacio. Idempotente: un replay del sub-workflow no re-vincula.
--
-- Params:
--   :lead_id   lead creado (la conversacion se deriva de source_conversation_id)
-- =============================================================================
UPDATE opportunities o
SET promoted_lead_id = :lead_id::bigint,
    status_code = 'promoted',
    promoted_at = NOW(),
    updated_at = NOW()
FROM leads l
WHERE l.id = :lead_id::bigint
  AND o.conversation_id = l.source_conversation_id
  AND o.phone_number = l.phone_number
  AND o.deleted_at IS NULL
  AND o.promoted_lead_id IS NULL
RETURNING o.id AS opportunity_id, o.status_code;
