-- =============================================================================
-- 013_create_follow_ups.sql — Seguimiento automatico por cadencia 0/1/3/7/14
-- (PRD A-010 y campos de seguimiento 25.4).
-- -----------------------------------------------------------------------------
-- Brecha cerrada en la Unidad 6: cuando el cliente no responde, el bot agenda
-- una cadencia de recontacto automatico (dias 0/1/3/7/14 segun el estado de la
-- conversacion) con mensajes aprobados, ventana de envio y opt-out.
--
-- Estado (estado):
--   pending  -> agendado, esperando el tick del scheduler
--   sending  -> reclamado por un tick (claim_token para no duplicar)
--   sent     -> el mensaje se emitio para ese step (unica vez por step)
--   error    -> el envio fallo y quedan reintentos (backoff via next_retry_at)
--   cancelled -> cadencia cancelada (cliente respondio / derivo a humano /
--               lead cerrado o perdido). Proximos steps futuros tambien.
--   opted_out -> el cliente pidio que no le escriban mas: nunca se envia.
--
-- Idempotencia: un unico follow_up activo por (conversacion, step_dia). El
-- indice parcial sobre (conversation_id, step_dia) con estado activo hace que
-- un replay del mismo evento no duplique y que un step cancelado/completado
-- pueda reabrirse en un ciclo nuevo (lead recuperable).
--
-- El scheduler (OPS - Follow-Up Scheduler) usa claim_due_follow_up() para
-- reclamar en batches con FOR UPDATE SKIP LOCKED y ventana horaria
-- configurable (env en el fixture a nivel de n8n o parametros del nodo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS follow_ups (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  opportunity_id BIGINT REFERENCES opportunities(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  motivo TEXT NOT NULL,
  step_dia SMALLINT NOT NULL CHECK (step_dia IN (0, 1, 3, 7, 14)),
  scheduled_at TIMESTAMPTZ NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pending'
    CHECK (estado IN ('pending', 'sending', 'sent', 'error', 'cancelled', 'opted_out')),
  result TEXT
    CHECK (result IS NULL OR result IN ('no_response', 'responded', 'quoted', 'called', 'lost', 'completed')),
  lost_reason TEXT,
  lost_step_dia SMALLINT,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  send_attempt_count INTEGER NOT NULL DEFAULT 0,
  max_send_attempts INTEGER NOT NULL DEFAULT 3,
  delivery_log JSONB NOT NULL DEFAULT '[]'::JSONB,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  last_window_skip_at TIMESTAMPTZ,
  last_send_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_follow_ups_phone CHECK (phone_number <> ''),
  CONSTRAINT chk_follow_ups_idempotency CHECK (idempotency_key <> '')
);

-- Un solo follow_up activo por (conversacion, step): si ya existe pending o
-- sending, el schedule de ese step es idempotente (no duplica).
CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_ups_active_step
ON follow_ups (conversation_id, step_dia)
WHERE deleted_at IS NULL AND estado IN ('pending', 'sending');

-- Cola del scheduler: pendientes ordenados por vencimiento para claim.
CREATE INDEX IF NOT EXISTS idx_follow_ups_due_queue
ON follow_ups (estado, scheduled_at, opted_out)
WHERE deleted_at IS NULL AND estado = 'pending';

-- Cancelacion por conversacion (cliente respondio / derivo / perdida).
CREATE INDEX IF NOT EXISTS idx_follow_ups_conversation
ON follow_ups (conversation_id, estado)
WHERE deleted_at IS NULL;

-- Consultas operativas por oportunidad (dashboard CRM).
CREATE INDEX IF NOT EXISTS idx_follow_ups_opportunity
ON follow_ups (opportunity_id)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_follow_ups_updated_at ON follow_ups;

CREATE TRIGGER set_follow_ups_updated_at
BEFORE UPDATE ON follow_ups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- claim_due_follow_ups(p_batch, p_window_start, p_window_end, p_now,
--                      p_claim_stale_seconds)
-- -----------------------------------------------------------------------------
-- Reclama los follow_ups vencidos dentro de la ventana de envio. Devuelve
-- exactamente los items reclamados por ESTE tick: el UPDATE con
-- FOR UPDATE SKIP LOCKED evita que dos ticks (o dos nodos en paralelo)
-- reenvien el mismo mensaje a la misma conversacion.
--
-- Un item fuera de la ventana NO se reclama: queda pending y el scheduler lo
-- evalua de nuevo (skip de ventana registrado en audit por 07_log_window_skip).
-- =============================================================================
CREATE OR REPLACE FUNCTION claim_due_follow_ups(
  p_batch_size INTEGER,
  p_window_start TEXT,
  p_window_end TEXT,
  p_now TIMESTAMPTZ,
  p_claim_stale_seconds INTEGER DEFAULT 900
)
RETURNS TABLE (
  id BIGINT,
  idempotency_key TEXT,
  conversation_id BIGINT,
  opportunity_id BIGINT,
  phone_number TEXT,
  motivo TEXT,
  step_dia SMALLINT,
  scheduled_at TIMESTAMPTZ,
  estado TEXT,
  send_attempt_count INTEGER,
  opted_out BOOLEAN,
  claim_token UUID,
  claimed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_size INTEGER := GREATEST(1, COALESCE(p_batch_size, 50));
  v_window_start TIME := COALESCE(p_window_start, '09:00')::TIME;
  v_window_end TIME := COALESCE(p_window_end, '20:00')::TIME;
  v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_stale_seconds INTEGER := GREATEST(30, COALESCE(p_claim_stale_seconds, 300));
BEGIN
  -- 1) Recupera en la ventana: items vencidos y no reclamados por otro tick.
  RETURN QUERY
  WITH target AS (
    SELECT f.id
    FROM follow_ups f
    WHERE f.deleted_at IS NULL
      AND f.estado = 'pending'
      AND f.opted_out = FALSE
      AND f.scheduled_at <= v_now
      AND v_now::TIME >= v_window_start
      AND v_now::TIME <= v_window_end
    ORDER BY f.scheduled_at ASC
    LIMIT v_batch_size FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE follow_ups f
    SET estado = 'sending',
        claim_token = gen_random_uuid(),
        claimed_at = v_now,
        updated_at = v_now
    FROM target t
    WHERE f.id = t.id
    RETURNING f.*
  )
  SELECT
    claimed.id,
    claimed.idempotency_key,
    claimed.conversation_id,
    claimed.opportunity_id,
    claimed.phone_number,
    claimed.motivo,
    claimed.step_dia,
    claimed.scheduled_at,
    claimed.estado,
    claimed.send_attempt_count,
    claimed.opted_out,
    claimed.claim_token,
    claimed.claimed_at
  FROM claimed;
END;
$$;