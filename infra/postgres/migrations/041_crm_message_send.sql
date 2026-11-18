-- CRM -> bot message.send: a seller replies to the customer from the CRM.
--
-- Agreed with the CRM in .orca/drops/whatsapp-events-1.2-conversations-*.md.
-- Additive only: one new table and two functions. No ClickUp query, table or
-- workflow changes; the ownership path is reused through
-- crm_inbound_apply_chat_event() (migration 040), unchanged.
--
-- 1. crm_outbound_messages: the send intent, persisted and claimed BEFORE
--    Evolution is called, keyed by the CRM event_id and by its
--    client_message_id. Status:
--      sending  claimed, Evolution call in flight (or the worker died in it);
--      sent     Evolution accepted it; message_id is the messages row;
--      failed   Evolution proved it did not send it; a retry sends again;
--      unknown  ambiguous Evolution outcome (timeout, 5xx).
--    'sending' and 'unknown' are NEVER resent automatically: Evolution has no
--    idempotency key, so a resend could reach the customer twice. An operator
--    resolves them (docs/crm-integration/README.md, "Stuck message.send").
-- 2. crm_inbound_claim_message_send(): idempotency, opportunity / seller
--    resolution, ownership (implicit take when the bot holds the chat, 409 when
--    another seller does) and the claim, in one transaction.
-- 3. crm_inbound_complete_message_send(): records the Evolution outcome. On
--    success it stores the message as an outgoing 'human' (seller) message,
--    the same shape as a seller's reply from their own phone, so the
--    dispatcher emits the usual message.new with sender "seller", and the
--    fromMe echo of that message is recognized by external_message_id and not
--    stored again (08_persist_own_message_from_evolution.sql).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Send intent
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_outbound_messages (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  client_message_id UUID NOT NULL,
  body_sha256 TEXT NOT NULL,
  crm_opportunity_id UUID NOT NULL,
  crm_seller_id UUID NOT NULL,
  seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  instance_name TEXT,
  text_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',
  attempt_count INTEGER NOT NULL DEFAULT 1,
  -- ownership_version right after the claim (and its implicit take, if any).
  ownership_version BIGINT NOT NULL,
  message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  provider_message_id TEXT,
  provider_status INTEGER,
  last_error TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_outbound_messages_event_key UNIQUE (event_id),
  CONSTRAINT crm_outbound_messages_client_message_key UNIQUE (client_message_id),
  CONSTRAINT chk_crm_outbound_messages_sha256 CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_crm_outbound_messages_status CHECK (status IN ('sending', 'sent', 'failed', 'unknown')),
  CONSTRAINT chk_crm_outbound_messages_attempts CHECK (attempt_count >= 1),
  CONSTRAINT chk_crm_outbound_messages_text CHECK (btrim(text_body) <> '' AND char_length(text_body) <= 4096),
  CONSTRAINT chk_crm_outbound_messages_sent CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

-- The dispatcher reads the sender of a CRM-sent message through message_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_outbound_messages_message
ON crm_outbound_messages (message_id)
WHERE message_id IS NOT NULL;

-- Operator view of sends that need a decision.
CREATE INDEX IF NOT EXISTS idx_crm_outbound_messages_unresolved
ON crm_outbound_messages (claimed_at)
WHERE status IN ('sending', 'unknown');

DROP TRIGGER IF EXISTS set_crm_outbound_messages_updated_at ON crm_outbound_messages;
CREATE TRIGGER set_crm_outbound_messages_updated_at
BEFORE UPDATE ON crm_outbound_messages
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Claim
-- -----------------------------------------------------------------------------
-- Returns either a final answer (send = FALSE: http_status + response) or a
-- claimed intent to deliver (send = TRUE: outbound_id, attempt, phone_number,
-- instance_name, text_body). The signature, envelope and data shape were
-- checked by the workflow first.
--   * Idempotency, shared with chat.take / chat.release through
--     crm_inbound_events and the same per-event_id lock:
--       - same event_id, other bytes -> 409 event_conflict (not stored);
--       - same bytes, intent 'sent' or a final answer -> the stored response;
--       - same bytes, intent 'sending' / 'unknown' -> 503, nothing is resent;
--       - same bytes, intent 'failed' -> evaluated and claimed again.
--     A client_message_id already used by another event_id -> 409
--     event_conflict (not stored).
--   * Opportunity and seller -> 422 exactly as chat.take.
--   * Ownership (data.ownership_version never blocks: a seller replying is
--     attending): the sender holds the chat -> send. The bot holds it -> the
--     chat is taken for the sender by crm_inbound_apply_chat_event() itself,
--     with a synthetic event id "message.send/<event_id>/take-<attempt>" ("/"
--     is outside the CRM event_id alphabet, so it never collides): same
--     effect as an applied chat.take (bot silent, 2-hour window, version
--     advanced, ownership.taken source crm). Another seller holds it -> 409
--     ownership_conflict with the holder and the current version.
--   * A claimed intent leaves a provisional 503 in crm_inbound_events, so the
--     event_id is taken for chat.take too; completion replaces it with 200.
CREATE OR REPLACE FUNCTION crm_inbound_claim_message_send(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_opportunity_id UUID,
  p_seller_id UUID,
  p_client_message_id UUID,
  p_ownership_version BIGINT,
  p_text TEXT
)
RETURNS TABLE (
  http_status INTEGER,
  response JSONB,
  replayed BOOLEAN,
  send BOOLEAN,
  outbound_id BIGINT,
  attempt INTEGER,
  phone_number TEXT,
  instance_name TEXT,
  text_body TEXT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_stored crm_inbound_events%ROWTYPE;
  v_outbound crm_outbound_messages%ROWTYPE;
  v_lead leads%ROWTYPE;
  v_seller sellers%ROWTYPE;
  v_active lead_chat_ownerships%ROWTYPE;
  v_has_stored BOOLEAN := FALSE;
  v_retry BOOLEAN := FALSE;
  v_live BOOLEAN := FALSE;
  v_conversation BIGINT;
  v_current BIGINT;
  v_holder BIGINT;
  v_attempt INTEGER;
  v_take_status INTEGER;
  v_take_response JSONB;
  v_phone TEXT;
  v_instance TEXT;
  v_status INTEGER;
  v_response JSONB;
BEGIN
  IF p_event_id IS NULL OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
     OR p_opportunity_id IS NULL OR p_seller_id IS NULL OR p_client_message_id IS NULL
     OR p_ownership_version IS NULL OR p_ownership_version < 0
     OR p_text IS NULL OR btrim(p_text) = '' OR char_length(p_text) > 4096 THEN
    RAISE EXCEPTION 'crm_inbound_claim_message_send: invalid arguments';
  END IF;

  -- Same key as crm_inbound_apply_chat_event: one event_id, one decision.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-inbound-event:' || p_event_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-message-send-client:' || p_client_message_id::text, 0));

  SELECT e.* INTO v_stored FROM crm_inbound_events e WHERE e.event_id = p_event_id;
  v_has_stored := FOUND;
  IF v_has_stored THEN
    IF v_stored.body_sha256 <> p_body_sha256 THEN
      RETURN QUERY SELECT 409, jsonb_build_object('error', 'event_conflict', 'event_id', p_event_id), FALSE,
        FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    SELECT o.* INTO v_outbound FROM crm_outbound_messages o WHERE o.event_id = p_event_id FOR UPDATE;
    IF NOT FOUND OR v_outbound.status = 'sent' THEN
      RETURN QUERY SELECT v_stored.http_status, v_stored.response, TRUE,
        FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    IF v_outbound.status IN ('sending', 'unknown') THEN
      RETURN QUERY SELECT 503, jsonb_build_object('error', 'receiver_unavailable'), TRUE,
        FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    v_retry := TRUE;
  ELSIF EXISTS (SELECT 1 FROM crm_outbound_messages o WHERE o.client_message_id = p_client_message_id) THEN
    RETURN QUERY SELECT 409, jsonb_build_object('error', 'event_conflict', 'event_id', p_event_id), FALSE,
      FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT l.* INTO v_lead
  FROM leads l
  WHERE l.crm_opportunity_id = p_opportunity_id
    AND l.deleted_at IS NULL
  ORDER BY l.id DESC
  LIMIT 1;
  IF FOUND THEN
    v_conversation := crm_lead_conversation_id(v_lead.id);
  END IF;

  IF v_lead.id IS NULL OR v_conversation IS NULL THEN
    v_status := 422;
    v_response := jsonb_build_object('error', 'invalid_opportunity', 'event_id', p_event_id);
  ELSE
    SELECT s.* INTO v_seller
    FROM sellers s
    WHERE s.crm_user_id = p_seller_id
      AND s.deleted_at IS NULL
      AND s.is_active
    LIMIT 1;

    IF v_seller.id IS NULL THEN
      v_status := 422;
      v_response := jsonb_build_object('error', 'invalid_seller', 'event_id', p_event_id);
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'chat-authority:' || v_lead.source_number_id::text || ':' || v_lead.phone_number, 0
      ));

      SELECT o.* INTO v_active
      FROM lead_chat_ownerships o
      WHERE o.lead_id = v_lead.id
        AND o.released_at IS NULL
        AND o.deleted_at IS NULL
      FOR UPDATE;
      v_live := FOUND AND (v_active.response_due_at IS NULL OR v_active.response_due_at > NOW());

      SELECT cco.ownership_version INTO v_current
      FROM crm_conversation_ownership cco
      WHERE cco.conversation_id = v_conversation
      FOR UPDATE;
      v_current := COALESCE(v_current, 0);

      IF v_live THEN
        v_holder := COALESCE(v_active.owner_seller_id, v_lead.assigned_seller_id);
      END IF;

      IF v_live AND v_holder IS DISTINCT FROM v_seller.id THEN
        v_status := 409;
        v_response := jsonb_build_object(
          'error', 'ownership_conflict',
          'holder_crm_seller_id', (
            SELECT s.crm_user_id FROM sellers s WHERE s.id = v_holder AND s.deleted_at IS NULL
          ),
          'ownership_version', v_current
        );
      ELSE
        v_attempt := CASE WHEN v_retry THEN v_outbound.attempt_count + 1 ELSE 1 END;

        IF NOT v_live THEN
          SELECT t.http_status, t.response INTO v_take_status, v_take_response
          FROM crm_inbound_apply_chat_event(
            'message.send/' || p_event_id || '/take-' || v_attempt::text,
            p_body_sha256, 'chat.take', p_opportunity_id, p_seller_id, v_current
          ) t;
          IF v_take_status IS DISTINCT FROM 200 OR v_take_response->>'result' IS DISTINCT FROM 'applied' THEN
            RAISE EXCEPTION 'crm_inbound_claim_message_send: implicit take not applied (%)', v_take_status;
          END IF;
          SELECT cco.ownership_version INTO v_current
          FROM crm_conversation_ownership cco WHERE cco.conversation_id = v_conversation;
          v_current := COALESCE(v_current, 0);
        END IF;

        SELECT c.phone_number,
               COALESCE(
                 NULLIF(wn.instance_name, ''),
                 (SELECT m.provider_instance_name
                  FROM messages m
                  WHERE m.conversation_id = c.id
                    AND NULLIF(m.provider_instance_name, '') IS NOT NULL
                  ORDER BY m.id DESC
                  LIMIT 1)
               )
        INTO v_phone, v_instance
        FROM conversations c
        LEFT JOIN whatsapp_numbers wn ON wn.id = c.source_number_id AND wn.deleted_at IS NULL
        WHERE c.id = v_conversation;

        IF v_retry THEN
          UPDATE crm_outbound_messages o
          SET status = 'sending',
              attempt_count = v_attempt,
              seller_id = v_seller.id,
              lead_id = v_lead.id,
              conversation_id = v_conversation,
              phone_number = v_phone,
              instance_name = v_instance,
              ownership_version = v_current,
              provider_status = NULL,
              last_error = NULL,
              claimed_at = NOW(),
              completed_at = NULL
          WHERE o.id = v_outbound.id
          RETURNING o.* INTO v_outbound;
        ELSE
          INSERT INTO crm_outbound_messages (
            event_id, client_message_id, body_sha256, crm_opportunity_id, crm_seller_id,
            seller_id, lead_id, conversation_id, phone_number, instance_name, text_body,
            status, attempt_count, ownership_version
          ) VALUES (
            p_event_id, p_client_message_id, p_body_sha256, p_opportunity_id, p_seller_id,
            v_seller.id, v_lead.id, v_conversation, v_phone, v_instance, p_text,
            'sending', 1, v_current
          )
          RETURNING * INTO v_outbound;

          INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
          VALUES (p_event_id, 'message.send', p_body_sha256, 503,
                  jsonb_build_object('error', 'receiver_unavailable'), v_lead.id, v_conversation);
        END IF;

        INSERT INTO audit_logs (
          event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
        ) VALUES (
          'crm_message_send_claimed', 'crm_outbound_message', v_outbound.id, 'system',
          'crm-inbound-events', 'sending',
          jsonb_build_object('lead_id', v_lead.id, 'conversation_id', v_conversation,
                             'crm_event_id', p_event_id, 'crm_seller_id', p_seller_id,
                             'attempt', v_attempt, 'implicit_take', NOT v_live)
        );

        RETURN QUERY SELECT NULL::INTEGER, NULL::JSONB, v_retry,
          TRUE, v_outbound.id, v_outbound.attempt_count, v_outbound.phone_number,
          v_outbound.instance_name, v_outbound.text_body;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- A final answer before anything was sent. A retry of a failed intent keeps
  -- its provisional row: the next retry evaluates it again.
  IF NOT v_has_stored THEN
    INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
    VALUES (p_event_id, 'message.send', p_body_sha256, v_status, v_response, v_lead.id, v_conversation);
  END IF;

  RETURN QUERY SELECT v_status, v_response, FALSE,
    FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Completion
-- -----------------------------------------------------------------------------
-- Records the Evolution outcome of one claimed attempt. Only the intent in
-- 'sending' with that attempt number moves; anything else answers what the
-- intent says now (200 for 'sent', else 503) and changes nothing.
--   failed  -> 'failed', 503: the CRM retry sends again.
--   unknown -> 'unknown', 503: never resent automatically.
--   sent    -> one outgoing 'human' message in the conversation (adopting the
--              row the fromMe echo stored if the echo won the race), the
--              seller's reply satisfies the live window like a phone reply
--              (04_register_human_reply.sql 'reply_registered'), 'sent', and
--              the stored 200 {event_id, result, message_id, ownership_version}.
CREATE OR REPLACE FUNCTION crm_inbound_complete_message_send(
  p_outbound_id BIGINT,
  p_attempt INTEGER,
  p_outcome TEXT,
  p_provider_message_id TEXT,
  p_provider_status INTEGER,
  p_error TEXT,
  p_id_prefix TEXT
)
RETURNS TABLE (http_status INTEGER, response JSONB)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_outbound crm_outbound_messages%ROWTYPE;
  v_lead leads%ROWTYPE;
  v_message_id BIGINT;
  v_current BIGINT;
  v_response JSONB;
BEGIN
  IF p_outbound_id IS NULL OR p_attempt IS NULL OR p_outcome IS NULL
     OR p_outcome NOT IN ('sent', 'failed', 'unknown')
     OR (p_outcome = 'sent' AND (p_id_prefix IS NULL OR p_id_prefix !~ '^[a-z0-9]{1,16}$')) THEN
    RAISE EXCEPTION 'crm_inbound_complete_message_send: invalid arguments';
  END IF;

  SELECT o.* INTO v_outbound FROM crm_outbound_messages o WHERE o.id = p_outbound_id FOR UPDATE;
  IF NOT FOUND OR v_outbound.status <> 'sending' OR v_outbound.attempt_count <> p_attempt THEN
    IF FOUND AND v_outbound.status = 'sent' THEN
      RETURN QUERY SELECT e.http_status, e.response FROM crm_inbound_events e WHERE e.event_id = v_outbound.event_id;
    ELSE
      RETURN QUERY SELECT 503, jsonb_build_object('error', 'receiver_unavailable');
    END IF;
    RETURN;
  END IF;

  IF p_outcome IN ('failed', 'unknown') THEN
    UPDATE crm_outbound_messages o
    SET status = p_outcome,
        provider_status = p_provider_status,
        last_error = left(COALESCE(NULLIF(p_error, ''), p_outcome), 1000),
        completed_at = NOW()
    WHERE o.id = v_outbound.id;

    INSERT INTO audit_logs (
      event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
    ) VALUES (
      'crm_message_send_completed', 'crm_outbound_message', v_outbound.id, 'system',
      'crm-inbound-events', p_outcome,
      jsonb_build_object('crm_event_id', v_outbound.event_id, 'attempt', p_attempt,
                         'provider_status', p_provider_status)
    );
    RETURN QUERY SELECT 503, jsonb_build_object('error', 'receiver_unavailable');
    RETURN;
  END IF;

  SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_outbound.lead_id;
  IF v_lead.id IS NOT NULL THEN
    -- Same chat-authority lock as 04_register_human_reply.sql.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'chat-authority:' || v_lead.source_number_id::text || ':' || v_lead.phone_number, 0
    ));
  END IF;

  INSERT INTO messages (
    conversation_id, lead_id, direction, sender_type, message_type,
    external_message_id, external_timestamp, delivery_status, text_body,
    raw_payload, provider_instance_name, idempotency_key
  ) VALUES (
    v_outbound.conversation_id, v_outbound.lead_id, 'outgoing', 'human', 'text',
    NULLIF(p_provider_message_id, ''), NOW(), 'sent', v_outbound.text_body,
    jsonb_build_object(
      'source', 'crm_message_send',
      'crm_event_id', v_outbound.event_id,
      'client_message_id', v_outbound.client_message_id,
      'crm_seller_id', v_outbound.crm_seller_id
    ),
    v_outbound.instance_name,
    'crm-message-send:' || v_outbound.client_message_id::text
  )
  ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    -- The fromMe echo was stored first (08_persist_own_message_from_evolution
    -- as a 'human' reply): that row is this message.
    SELECT m.id INTO v_message_id
    FROM messages m
    WHERE m.external_message_id = NULLIF(p_provider_message_id, '');
  END IF;

  UPDATE conversations c
  SET last_message_at = GREATEST(c.last_message_at, NOW()),
      updated_at = NOW()
  WHERE c.id = v_outbound.conversation_id;

  -- The seller answered: the pending customer message is satisfied and the
  -- live lease stays held, as 04_register_human_reply.sql does for a reply from
  -- the seller's phone. An expired or released lease is left to that query,
  -- which the fromMe echo runs.
  IF v_lead.id IS NOT NULL THEN
    UPDATE lead_chat_ownerships o
    SET pending_message_id = NULL,
        pending_message_at = NULL,
        response_due_at = NULL,
        last_human_message_id = v_message_id,
        last_human_reply_at = NOW(),
        updated_at = NOW()
    WHERE o.lead_id = v_lead.id
      AND o.released_at IS NULL
      AND o.deleted_at IS NULL
      AND (o.response_due_at IS NULL OR o.response_due_at > NOW());
  END IF;

  SELECT cco.ownership_version INTO v_current
  FROM crm_conversation_ownership cco
  WHERE cco.conversation_id = v_outbound.conversation_id;

  v_response := jsonb_build_object(
    'event_id', v_outbound.event_id,
    'result', 'sent',
    'message_id', 'wa-' || p_id_prefix || '-message-' || v_message_id::text,
    'ownership_version', COALESCE(v_current, 0)
  );

  UPDATE crm_outbound_messages o
  SET status = 'sent',
      message_id = v_message_id,
      provider_message_id = NULLIF(p_provider_message_id, ''),
      provider_status = p_provider_status,
      last_error = NULL,
      sent_at = NOW(),
      completed_at = NOW()
  WHERE o.id = v_outbound.id;

  UPDATE crm_inbound_events e
  SET http_status = 200,
      response = v_response
  WHERE e.event_id = v_outbound.event_id;

  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
  ) VALUES (
    'crm_message_send_completed', 'crm_outbound_message', v_outbound.id, 'system',
    'crm-inbound-events', 'sent',
    jsonb_build_object('crm_event_id', v_outbound.event_id, 'attempt', p_attempt,
                       'message_id', v_message_id, 'provider_status', p_provider_status)
  );

  RETURN QUERY SELECT 200, v_response;
END;
$$;

COMMIT;
