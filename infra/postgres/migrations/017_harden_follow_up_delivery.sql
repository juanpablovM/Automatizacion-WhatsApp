-- Harden A-010 follow-up delivery: durable opt-out, cycle idempotency,
-- reclaimable retries/stale claims, and safe retries of known outbound failures.

CREATE TABLE IF NOT EXISTS follow_up_preferences (
  conversation_id BIGINT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  opted_out_at TIMESTAMPTZ,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  source_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_follow_up_preferences_updated_at ON follow_up_preferences;
CREATE TRIGGER set_follow_up_preferences_updated_at
BEFORE UPDATE ON follow_up_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE follow_ups
  ADD COLUMN IF NOT EXISTS cycle_key TEXT;

UPDATE follow_ups
SET cycle_key = COALESCE(NULLIF(metadata->>'cycle_key', ''), 'legacy:' || id::text)
WHERE cycle_key IS NULL OR cycle_key = '';

ALTER TABLE follow_ups ALTER COLUMN cycle_key SET NOT NULL;

DROP INDEX IF EXISTS uq_follow_ups_active_step;
CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_ups_cycle_step
ON follow_ups (conversation_id, cycle_key, step_dia)
WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_follow_ups_due_queue;
CREATE INDEX IF NOT EXISTS idx_follow_ups_due_queue
ON follow_ups (COALESCE(next_retry_at, scheduled_at), estado)
WHERE deleted_at IS NULL AND estado IN ('pending', 'error', 'sending');

DROP FUNCTION IF EXISTS claim_due_follow_ups(INTEGER, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
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
  cycle_key TEXT,
  conversation_id BIGINT,
  opportunity_id BIGINT,
  phone_number TEXT,
  source_number_id BIGINT,
  instance_name TEXT,
  motivo TEXT,
  step_dia SMALLINT,
  scheduled_at TIMESTAMPTZ,
  estado TEXT,
  send_attempt_count INTEGER,
  max_send_attempts INTEGER,
  opted_out BOOLEAN,
  claim_token UUID,
  claimed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_size INTEGER := GREATEST(1, COALESCE(p_batch_size, 50));
  v_window_start TIME := COALESCE(NULLIF(p_window_start, ''), '09:00')::TIME;
  v_window_end TIME := COALESCE(NULLIF(p_window_end, ''), '20:00')::TIME;
  v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_stale_seconds INTEGER := GREATEST(30, COALESCE(p_claim_stale_seconds, 900));
BEGIN
  RETURN QUERY
  WITH target AS (
    SELECT f.id
    FROM follow_ups f
    LEFT JOIN follow_up_preferences p ON p.conversation_id = f.conversation_id
    WHERE f.deleted_at IS NULL
      AND f.opted_out = FALSE
      AND COALESCE(p.opted_out, FALSE) = FALSE
      AND f.send_attempt_count < f.max_send_attempts
      AND (
        (f.estado = 'pending' AND f.scheduled_at <= v_now)
        OR (f.estado = 'error' AND f.next_retry_at IS NOT NULL AND f.next_retry_at <= v_now)
        OR (f.estado = 'sending' AND COALESCE(f.claimed_at, f.updated_at) <= v_now - make_interval(secs => v_stale_seconds))
      )
      AND v_now::TIME >= v_window_start
      AND v_now::TIME <= v_window_end
    ORDER BY COALESCE(f.next_retry_at, f.scheduled_at), f.id
    LIMIT v_batch_size
    FOR UPDATE OF f SKIP LOCKED
  ), claimed AS (
    UPDATE follow_ups f
    SET estado = 'sending', claim_token = gen_random_uuid(), claimed_at = v_now,
        next_retry_at = NULL, updated_at = v_now
    FROM target t
    WHERE f.id = t.id
    RETURNING f.*
  )
  SELECT c.id, c.idempotency_key, c.cycle_key, c.conversation_id,
         c.opportunity_id, c.phone_number, c.source_number_id, wn.instance_name,
         c.motivo, c.step_dia, c.scheduled_at, c.estado,
         c.send_attempt_count, c.max_send_attempts, c.opted_out,
         c.claim_token, c.claimed_at
  FROM claimed c
  LEFT JOIN whatsapp_numbers wn ON wn.id = c.source_number_id;
END;
$$;

-- A provider-confirmed failure is safe to retry. Ambiguous/unknown outbound
-- operations remain quarantined and are never reclaimed here.
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
      conversation_id, lead_id, direction, message_type, delivery_status,
      text_body, raw_payload, provider_instance_name, idempotency_key,
      dispatch_phase, dispatch_token, claimed_at
    ) VALUES (
      p_conversation_id, p_lead_id, 'outgoing', COALESCE(p_message_type, 'text'),
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
