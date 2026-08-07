-- =============================================================================
-- 011_create_handoffs.sql — Escalamiento humano durable y enrutado (PRD #22/#23).
-- -----------------------------------------------------------------------------
-- Brecha P0 cerrada en la Unidad 3: todo escalamiento produce un registro
-- durable (handoffs) y una notificacion verificable al area responsable.
--
-- Ciclo de vida (estado):
--   pending  -> creado por la lane de escalamiento del dispatcher
--   notified -> el area fue notificada exitosamente (una sola vez, con
--               notification_attempt_count y notified_at como evidencia)
--   acknowledged -> el area confirmo la recepcion (operacion OPS)
--   resolved -> el area cerro el caso (operacion OPS)
--
-- Idempotencia: la clave `{conversation_id}:{motivo}:{trigger}` mantiene un
-- unico handoff activo por evento; un replay del dispatch (recovery) nunca
-- duplica filas y queda trazado en audit_logs como 'duplicate_skipped'.
--
-- El routing motivo->area->prioridad->responsable vive en el fixture
-- tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/
-- ensure-escalation-handoff.js (source of truth) y se persiste aqui como
-- snapshot por fila para auditoria y colas por area.
-- =============================================================================

CREATE TABLE IF NOT EXISTS handoffs (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  inbound_event_id BIGINT,
  motivo TEXT NOT NULL,
  area TEXT NOT NULL,
  area_label TEXT NOT NULL,
  prioridad TEXT NOT NULL CHECK (prioridad IN ('urgente', 'alta', 'media', 'baja')),
  responsable TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pending'
    CHECK (estado IN ('pending', 'notified', 'acknowledged', 'resolved')),
  trigger TEXT,
  escalation_reason TEXT,
  escalation_area TEXT,
  intent TEXT,
  notification_channel TEXT NOT NULL DEFAULT 'internal',
  notification_attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  notified_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  last_notification_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_handoffs_phone CHECK (phone_number <> ''),
  CONSTRAINT chk_handoffs_idempotency CHECK (idempotency_key <> '')
);

-- Idempotencia del evento de escalamiento: el ON CONFLICT del upsert (nodo
-- "Upsert Escalation Handoff") depende de que este indice parcial coincida
-- con el predicado `WHERE deleted_at IS NULL`.
CREATE UNIQUE INDEX IF NOT EXISTS uq_handoffs_idempotency
ON handoffs (idempotency_key)
WHERE deleted_at IS NULL;

-- Cola de notificacion por area: los handoffs pendientes de notificar o
-- reintentar (pending con intentos disponibles).
CREATE INDEX IF NOT EXISTS idx_handoffs_notification_queue
ON handoffs (estado, notification_attempt_count, max_attempts)
WHERE deleted_at IS NULL AND estado = 'pending';

-- Consultas operativas por estado/prioridad (dashboard de areas).
CREATE INDEX IF NOT EXISTS idx_handoffs_estado_prioridad
ON handoffs (estado, prioridad, created_at)
WHERE deleted_at IS NULL;

-- Ciclo de vida por contacto/conversacion.
CREATE INDEX IF NOT EXISTS idx_handoffs_conversation
ON handoffs (conversation_id)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_handoffs_updated_at ON handoffs;

CREATE TRIGGER set_handoffs_updated_at
BEFORE UPDATE ON handoffs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();