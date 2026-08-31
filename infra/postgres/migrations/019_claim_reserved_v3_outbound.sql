-- The v3 commit reserves its exact outbox row before dispatch. Claim that row
-- instead of inserting a parallel evolution:* message, then expose a provider
-- body built from the immutable stored text.
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
  SELECT message.* INTO v_message FROM messages message
  WHERE message.direction = 'outgoing' AND message.deleted_at IS NULL
    AND message.idempotency_key = p_idempotency_key FOR UPDATE;

  IF NOT FOUND THEN
    v_token := md5(random()::TEXT || clock_timestamp()::TEXT || p_idempotency_key);
    INSERT INTO messages (
      conversation_id, lead_id, direction, message_type, delivery_status,
      text_body, raw_payload, provider_instance_name, idempotency_key,
      dispatch_phase, dispatch_token, claimed_at
    ) VALUES (
      p_conversation_id, p_lead_id, 'outgoing', COALESCE(p_message_type, 'text'),
      'queued', p_text_body, COALESCE(p_raw_payload, '{}'::JSONB),
      p_provider_instance_name, p_idempotency_key, 'claimed', v_token, NOW()
    ) RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.delivery_status = 'sent' OR v_message.dispatch_phase = 'sent' THEN
    v_should_send := FALSE;
  ELSIF v_message.dispatch_phase = 'reserved' THEN
    v_token := md5(random()::TEXT || clock_timestamp()::TEXT || p_idempotency_key);
    UPDATE messages message
    SET dispatch_phase = 'claimed', dispatch_token = v_token, claimed_at = NOW(),
        reconciliation_required = FALSE, reconciliation_reason = NULL, updated_at = NOW()
    WHERE message.id = v_message.id
    RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.dispatch_phase = 'failed' AND v_message.reconciliation_required = FALSE THEN
    v_token := md5(random()::TEXT || clock_timestamp()::TEXT || p_idempotency_key);
    UPDATE messages message SET delivery_status = 'queued', dispatch_phase = 'claimed',
      dispatch_token = v_token, claimed_at = NOW(), attempt_started_at = NULL,
      reconciliation_reason = NULL, updated_at = NOW()
    WHERE message.id = v_message.id RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.dispatch_phase = 'claimed'
    AND COALESCE(v_message.claimed_at, v_message.updated_at) < NOW() - make_interval(secs => v_stale_seconds) THEN
    v_token := md5(random()::TEXT || clock_timestamp()::TEXT || p_idempotency_key);
    UPDATE messages message SET dispatch_token = v_token, claimed_at = NOW(),
      reconciliation_required = FALSE, reconciliation_reason = NULL, updated_at = NOW()
    WHERE message.id = v_message.id RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.dispatch_phase = 'sending'
    AND COALESCE(v_message.attempt_started_at, v_message.updated_at) < NOW() - make_interval(secs => v_stale_seconds) THEN
    UPDATE messages message SET delivery_status = 'unknown', dispatch_phase = 'unknown',
      reconciliation_required = TRUE,
      reconciliation_reason = 'stale_sending_outcome_ambiguous', updated_at = NOW()
    WHERE message.id = v_message.id RETURNING * INTO v_message;
  END IF;

  RETURN QUERY SELECT v_message.id, v_message.conversation_id, v_message.lead_id,
    v_message.message_type, v_message.delivery_status, v_message.text_body,
    v_message.raw_payload, v_message.provider_instance_name, v_message.idempotency_key,
    v_message.raw_payload->>'number',
    jsonb_build_object(
      'number', v_message.raw_payload->>'number',
      'text', v_message.text_body,
      'delay', 0,
      'linkPreview', FALSE
    ),
    (v_message.delivery_status = 'sent' OR v_message.dispatch_phase = 'sent'),
    v_should_send, v_message.external_message_id, p_response_kind,
    v_message.dispatch_token, v_message.dispatch_phase, v_message.reconciliation_required;
END;
$$;
