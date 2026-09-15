-- =============================================================================
-- 018_create_lead_chat_ownerships.sql — Propiedad del chat: humano vs bot.
-- -----------------------------------------------------------------------------
-- PostgreSQL es la unica autoridad sobre si la IA puede responder. ClickUp es
-- señal de adquisicion y proyeccion operativa asincrona, nunca el arbitro: si
-- ClickUp esta caido la IA sigue decidiendo con lo que hay en esta tabla.
--
-- Ciclo de vida (derivado, sin enum de estado):
--   adquirida -> la tarea comercial paso a 'in progress' y el vendedor toma el
--                chat de forma provisoria (una fila mutable por adquisicion)
--   liberada  -> released_at IS NOT NULL, por transicion de ClickUp fuera de
--                'in progress' (release_reason='clickup_released') o por
--                vencimiento del SLA (release_reason='sla_expired')
--
-- La propiedad NO se guarda como texto: se deriva siempre con el mismo
-- predicado, y toda consulta de este dominio lo repite tal cual:
--   released_at IS NULL
--   AND deleted_at IS NULL
--   AND (response_due_at IS NULL OR response_due_at > NOW())
-- Un enum 'active|expired' obligaria a un job que lo mueva y crearia una
-- ventana en la que la fila dice 'active' pero el SLA ya vencio; el predicado
-- derivado no tiene esa ventana.
--
-- SLA: 2 horas de reloj por mensaje del cliente pendiente. El ultimo mensaje
-- del cliente antes del vencimiento es el pendiente y fija
-- response_due_at = message.created_at + INTERVAL '2 hours'. Un mensaje mas
-- nuevo lo REEMPLAZA y abre su propia ventana de 2 horas.
--
-- Regla critica: un mensaje nuevo del cliente NO revive un plazo ya vencido,
-- porque un cliente insistente no debe mantener al bot mudo para siempre. Una
-- respuesta humana verificada si gana la carrera: vuelve a adquirir propiedad
-- local y encola la proyeccion durable que devuelve ClickUp a 'in progress'.
--
-- Restauracion del estado previo de ClickUp: la liberacion interna nunca
-- espera a ClickUp. Primero se libera (released_at) y recien despues se
-- proyecta la restauracion con la maquina restoration_state, reclamada con
-- restoration_claim_token contra external_operations. Si nunca se capturo
-- previous_clickup_status la liberacion igual ocurre, pero la restauracion
-- queda en 'skipped_no_previous_status' con restoration_error visible: adivinar
-- un estado de ClickUp es peor que dejar la evidencia faltante a la vista.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_chat_ownerships (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  clickup_task_id TEXT NOT NULL,
  -- Nullable a proposito: NULL significa "no hay evidencia del estado previo",
  -- no "el estado previo era vacio". La restauracion lo trata como faltante.
  previous_clickup_status TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Identidad del evento de ClickUp que produjo la ultima proyeccion. Los
  -- webhooks duplican y llegan desordenados: sin estos dos campos un evento
  -- viejo reasigna la propiedad que un evento nuevo ya habia liberado.
  last_clickup_history_id TEXT,
  last_clickup_event_at TIMESTAMPTZ,
  pending_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  pending_message_at TIMESTAMPTZ,
  response_due_at TIMESTAMPTZ,
  last_human_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  last_human_reply_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  restoration_state TEXT NOT NULL DEFAULT 'not_required',
  restoration_claim_token TEXT,
  restoration_claimed_at TIMESTAMPTZ,
  restoration_completed_at TIMESTAMPTZ,
  restoration_attempt_count INTEGER NOT NULL DEFAULT 0,
  restoration_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_lead_chat_ownerships_task CHECK (clickup_task_id <> ''),
  CONSTRAINT chk_lead_chat_ownerships_release_reason
    CHECK (release_reason IN ('clickup_released', 'sla_expired', 'manual')),
  CONSTRAINT chk_lead_chat_ownerships_restoration_state
    CHECK (restoration_state IN (
      'not_required', 'pending', 'processing', 'succeeded', 'failed',
      'skipped_no_previous_status', 'skipped_status_changed'
    ))
);

-- Una sola propiedad viva por lead. Este indice tambien es el destino del
-- ON CONFLICT de 01_acquire_ownership_from_clickup.sql: la inferencia del
-- upsert depende de que el predicado parcial coincida exactamente con
-- `WHERE released_at IS NULL AND deleted_at IS NULL`. Si alguien cambia el
-- predicado aqui y no alla, el upsert deja de inferir el indice y falla en
-- ejecucion, no en migracion.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_chat_ownerships_active_lead
ON lead_chat_ownerships (lead_id)
WHERE released_at IS NULL AND deleted_at IS NULL;

-- Resolucion por tarea de ClickUp (webhooks de adquisicion y liberacion).
CREATE INDEX IF NOT EXISTS idx_lead_chat_ownerships_task
ON lead_chat_ownerships (clickup_task_id)
WHERE deleted_at IS NULL;

-- Cola de vencimiento del SLA: el barrido de 06_claim_expired_ownerships.sql
-- solo mira leases vivos con plazo fijado.
CREATE INDEX IF NOT EXISTS idx_lead_chat_ownerships_due
ON lead_chat_ownerships (response_due_at)
WHERE released_at IS NULL AND deleted_at IS NULL AND response_due_at IS NOT NULL;

-- Cola de restauracion en ClickUp, incluida la relectura de claims trabados
-- en 'processing' mas alla de su ventana.
CREATE INDEX IF NOT EXISTS idx_lead_chat_ownerships_restoration
ON lead_chat_ownerships (restoration_state, restoration_claimed_at)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_lead_chat_ownerships_updated_at ON lead_chat_ownerships;

CREATE TRIGGER set_lead_chat_ownerships_updated_at
BEFORE UPDATE ON lead_chat_ownerships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Evidencia de origen del mensaje.
-- -----------------------------------------------------------------------------
-- `direction` distingue entrante de saliente, pero no distingue un saliente
-- del bot de un saliente escrito por el vendedor desde su telefono. El SLA
-- necesita exactamente esa diferencia: solo una respuesta humana verificada
-- limpia el pendiente, y solo un mensaje del cliente abre plazo.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_type TEXT;

-- Backfill conservador de las filas historicas: lo unico que se sabe con
-- certeza de ellas es su direccion. No se inventa 'human' para ningun saliente
-- viejo porque no hay evidencia que lo respalde.
UPDATE messages
SET sender_type = CASE WHEN direction = 'incoming' THEN 'customer' ELSE 'bot' END
WHERE sender_type IS NULL;

ALTER TABLE messages ALTER COLUMN sender_type SET DEFAULT 'customer';
ALTER TABLE messages ALTER COLUMN sender_type SET NOT NULL;

-- PostgreSQL no ofrece ADD CONSTRAINT IF NOT EXISTS, asi que este es el unico
-- lugar del archivo donde hace falta un guard imperativo para que la migracion
-- sea reaplicable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_sender_type'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_messages_sender_type
      CHECK (sender_type IN ('customer', 'bot', 'human', 'system'));
  END IF;
END
$$;

-- La correlacion del eco del bot (el saliente que WhatsApp devuelve como
-- evento) busca por external_message_id. Ese indice ya existe desde
-- 003_create_indexes.sql como uq_messages_external_message_id (UNIQUE parcial
-- sobre (external_message_id) WHERE external_message_id IS NOT NULL) y cubre
-- esa busqueda, asi que aqui NO se crea idx_messages_external_message_id: un
-- segundo indice sobre la misma columna solo agregaria costo de escritura sin
-- responder ninguna consulta nueva.


-- Redefinicion posterior a sender_type: todo outbound automatizado es bot.
-- La funcion fue creada antes, en 017, cuando la columna aun no existia. Se
-- redefine aca —despues del ALTER TABLE— para que instalaciones nuevas y bases
-- migradas clasifiquen igual los mensajes enviados por el workflow outbound.
CREATE OR REPLACE FUNCTION claim_outbound_message(
  p_conversation_id BIGINT,
  p_lead_id BIGINT,
  p_message_type TEXT,
  p_text_body TEXT,
  p_raw_payload JSONB,
  p_response_kind TEXT,
  p_provider_instance_name TEXT,
  p_idempotency_key TEXT,
  p_claim_stale_seconds INTEGER
)
RETURNS TABLE (
  id BIGINT, conversation_id BIGINT, lead_id BIGINT, message_type TEXT,
  delivery_status TEXT, text_body TEXT, raw_payload JSONB, instance_name TEXT,
  idempotency_key TEXT, phone_number TEXT, outbound_body JSONB,
  already_sent BOOLEAN, should_send BOOLEAN, external_message_id TEXT,
  response_kind TEXT, dispatch_token TEXT, dispatch_phase TEXT,
  reconciliation_required BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_message messages%ROWTYPE;
  v_token TEXT;
  v_stale_seconds INTEGER := GREATEST(30, COALESCE(p_claim_stale_seconds, 300));
  v_should_send BOOLEAN := FALSE;
BEGIN
  IF p_idempotency_key IS NULL OR p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Outbound operation requires conversation_id and idempotency_key';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound:' || p_idempotency_key, 0));
  SELECT m.* INTO v_message FROM messages m
  WHERE m.direction = 'outgoing' AND m.deleted_at IS NULL
    AND m.idempotency_key = p_idempotency_key FOR UPDATE;

  IF NOT FOUND THEN
    v_token := md5(random()::text || clock_timestamp()::text || p_idempotency_key);
    INSERT INTO messages (
      conversation_id, lead_id, direction, sender_type, message_type, delivery_status,
      text_body, raw_payload, provider_instance_name, idempotency_key,
      dispatch_phase, dispatch_token, claimed_at
    ) VALUES (
      p_conversation_id, p_lead_id, 'outgoing', 'bot', COALESCE(p_message_type, 'text'),
      'queued', p_text_body, COALESCE(p_raw_payload, '{}'::jsonb),
      p_provider_instance_name, p_idempotency_key, 'claimed', v_token, NOW()
    ) RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.delivery_status = 'sent' OR v_message.dispatch_phase = 'sent' THEN
    v_should_send := FALSE;
  ELSIF v_message.dispatch_phase = 'failed' AND v_message.reconciliation_required = FALSE THEN
    v_token := md5(random()::text || clock_timestamp()::text || p_idempotency_key);
    UPDATE messages m SET delivery_status = 'queued', dispatch_phase = 'claimed',
      dispatch_token = v_token, claimed_at = NOW(), attempt_started_at = NULL,
      reconciliation_reason = NULL, updated_at = NOW()
    WHERE m.id = v_message.id RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.dispatch_phase = 'claimed'
    AND COALESCE(v_message.claimed_at, v_message.updated_at) < NOW() - make_interval(secs => v_stale_seconds) THEN
    v_token := md5(random()::text || clock_timestamp()::text || p_idempotency_key);
    UPDATE messages m SET dispatch_token = v_token, claimed_at = NOW(),
      reconciliation_required = FALSE, reconciliation_reason = NULL, updated_at = NOW()
    WHERE m.id = v_message.id RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.dispatch_phase = 'sending'
    AND COALESCE(v_message.attempt_started_at, v_message.updated_at) < NOW() - make_interval(secs => v_stale_seconds) THEN
    UPDATE messages m SET delivery_status = 'unknown', dispatch_phase = 'unknown',
      reconciliation_required = TRUE,
      reconciliation_reason = 'stale_sending_outcome_ambiguous', updated_at = NOW()
    WHERE m.id = v_message.id RETURNING * INTO v_message;
  END IF;

  RETURN QUERY SELECT v_message.id, v_message.conversation_id, v_message.lead_id,
    v_message.message_type, v_message.delivery_status, v_message.text_body,
    v_message.raw_payload, v_message.provider_instance_name, v_message.idempotency_key,
    v_message.raw_payload->>'number', v_message.raw_payload,
    (v_message.delivery_status = 'sent' OR v_message.dispatch_phase = 'sent'),
    v_should_send, v_message.external_message_id, p_response_kind,
    v_message.dispatch_token, v_message.dispatch_phase, v_message.reconciliation_required;
END;
$$;
