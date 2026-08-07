-- =============================================================================
-- 010_create_opportunities.sql — Ciclo de oportunidad desde el primer mensaje.
-- -----------------------------------------------------------------------------
-- PRD A-001: una oportunidad comercial nace con el primer mensaje de una
-- conversacion, ANTES de que el lead este calificado. `leads` sigue siendo el
-- escalon final del pipeline (ClickUp + asignacion + notificacion), por eso el
-- ciclo temprano vive en una tabla separada con su propio ciclo de vida:
--
--   new       -> creada al primer mensaje (idempotente por conversacion)
--   qualified -> gate comercial limpio + confirmacion del cliente
--   promoted  -> el lead fue creado y queda vinculado (promoted_lead_id)
--
-- Las intenciones operativas (reclamo, garantia, comprobante, factura) NO
-- crean oportunidad: son atencion postventa, no ciclo de venta.
-- =============================================================================

CREATE TABLE IF NOT EXISTS opportunities (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT NOT NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_contact_id TEXT,
  whatsapp_name TEXT,
  service TEXT,
  city TEXT,
  requirement TEXT,
  intent_code TEXT,
  status_code TEXT NOT NULL DEFAULT 'new'
    CHECK (status_code IN ('new', 'qualified', 'promoted')),
  blocked_reason TEXT,
  promoted_at TIMESTAMPTZ,
  promoted_lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  inbound_event_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_opportunities_phone CHECK (phone_number <> '')
);

-- Una conversacion tiene exactamente una oportunidad activa: el conflicto del
-- upsert (ON CONFLICT (conversation_id) WHERE deleted_at IS NULL) depende de
-- que el predicado de este indice sea identico al del nodo de persistencia.
CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunities_conversation
ON opportunities (conversation_id)
WHERE deleted_at IS NULL;

-- Ciclos de un mismo contacto a traves de conversaciones distintas (un cliente
-- que vuelve abre una nueva oportunidad por cada conversacion nueva).
CREATE INDEX IF NOT EXISTS idx_opportunities_contact
ON opportunities (phone_number, source_number_id)
WHERE deleted_at IS NULL;

-- Dashboard/colas por estado del ciclo.
CREATE INDEX IF NOT EXISTS idx_opportunities_status
ON opportunities (status_code, created_at)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_opportunities_updated_at ON opportunities;

CREATE TRIGGER set_opportunities_updated_at
BEFORE UPDATE ON opportunities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
