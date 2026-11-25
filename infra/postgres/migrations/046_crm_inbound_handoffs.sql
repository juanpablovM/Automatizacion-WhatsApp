-- CRM 1.2d, CRM -> bot: the conversation_id identity and the handoff closure
-- events on /webhook/crm-events.
--
-- Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S5, S6).
-- Contract: .orca/drops/whatsapp-events-1.2d-crm-response.md and -dev-live.md.
--
-- Additive. crm_inbound_apply_chat_event() (040) and
-- crm_inbound_claim_message_send() (041) are consumed contracts and stay
-- exactly as they are; the conversation path gets its own functions with the
-- same effects. No ClickUp query, table or workflow changes.
--
-- "Handed off to the CRM": crm_events has a handoff.created row with status
-- 'delivered' whose envelope conversation_id is the one the CRM sends back
-- (wa-<prefix>-conversation-<conversations.id>) and whose handoff belongs to
-- that conversation (written by the crm-events dispatcher, 044).
--
-- 1. crm_outbound_messages.crm_opportunity_id DROP NOT NULL, plus
--    crm_conversation_ref (the conversation_id the CRM sent): every send
--    intent carries exactly one identity. Existing rows all carry an
--    opportunity, so the check holds for them.
-- 2. crm_inbound_handoff_conversation(): resolves a CRM conversation_id to the
--    conversation's lead and the seller the bot routed its handoff to.
-- 3. crm_inbound_apply_conversation_chat_event(): chat.take / chat.release by
--    conversation_id, the effects of crm_inbound_apply_chat_event().
-- 4. crm_inbound_claim_conversation_message_send(): message.send by
--    conversation_id, the effects of crm_inbound_claim_message_send().
--    Completion is crm_inbound_complete_message_send() (041), unchanged.
-- 5. crm_inbound_apply_handoff_event(): handoff.acknowledged /
--    handoff.resolved with the transitions of
--    handoff-routing/05_close_handoff_from_clickup.sql.
--
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Send intents identified by conversation
-- -----------------------------------------------------------------------------
ALTER TABLE crm_outbound_messages ALTER COLUMN crm_opportunity_id DROP NOT NULL;
ALTER TABLE crm_outbound_messages ADD COLUMN IF NOT EXISTS crm_conversation_ref TEXT;

ALTER TABLE crm_outbound_messages DROP CONSTRAINT IF EXISTS chk_crm_outbound_messages_identity;
ALTER TABLE crm_outbound_messages ADD CONSTRAINT chk_crm_outbound_messages_identity CHECK (
  num_nonnulls(crm_opportunity_id, crm_conversation_ref) = 1
);

-- -----------------------------------------------------------------------------
-- 2. Conversation resolution
-- -----------------------------------------------------------------------------
-- status:
--   'unknown'  no delivered handoff.created for this conversation_id, the
--              conversation does not exist, its newest delivered handoff was
--              routed by opportunity, or a live lead of the conversation has
--              an opportunity (the CRM must use crm_opportunity_id) ->
--              422 unknown_conversation;
--   'no_lead'  handed off without an opportunity, but no live lead belongs to
--              the conversation: chat ownership (lead_chat_ownerships) needs a
--              lead, so nothing can be taken, released or sent ->
--              422 unknown_conversation as well;
--   'ok'       lead_id is the conversation's newest live lead (no
--              opportunity), routed_seller_id the seller of the newest
--              delivered handoff (handoffs.crm_routing_seller_id).
-- A lead belongs to the conversation when crm_lead_conversation_id() (040)
-- names it: the conversation its ownership versions are tracked under.
CREATE OR REPLACE FUNCTION crm_inbound_handoff_conversation(
  p_conversation_ref TEXT,
  p_conversation_id BIGINT
)
RETURNS TABLE (status TEXT, conversation_id BIGINT, lead_id BIGINT, routed_seller_id BIGINT)
LANGUAGE plpgsql
STABLE
AS $$
#variable_conflict use_column
DECLARE
  v_conversation conversations%ROWTYPE;
  v_routed BIGINT;
  v_opportunity UUID;
  v_handed BOOLEAN := FALSE;
  v_lead BIGINT;
BEGIN
  IF p_conversation_ref IS NOT NULL AND p_conversation_id IS NOT NULL THEN
    SELECT c.* INTO v_conversation
    FROM conversations c
    WHERE c.id = p_conversation_id AND c.deleted_at IS NULL;
  END IF;
  IF v_conversation.id IS NULL THEN
    RETURN QUERY SELECT 'unknown'::TEXT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT TRUE, h.crm_routing_seller_id, h.crm_opportunity_id INTO v_handed, v_routed, v_opportunity
  FROM crm_events e
  JOIN handoffs h ON h.id = e.handoff_id AND h.deleted_at IS NULL
  WHERE e.event_type = 'handoff.created'
    AND e.status = 'delivered'
    AND e.conversation_id = p_conversation_ref
    AND h.conversation_id = v_conversation.id
  ORDER BY e.id DESC
  LIMIT 1;

  IF NOT COALESCE(v_handed, FALSE) OR v_routed IS NULL OR v_opportunity IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM leads l
       WHERE l.deleted_at IS NULL
         AND (l.id = v_conversation.lead_id OR l.source_conversation_id = v_conversation.id)
         AND l.crm_opportunity_id IS NOT NULL
         AND crm_lead_conversation_id(l.id) = v_conversation.id
     ) THEN
    RETURN QUERY SELECT 'unknown'::TEXT, v_conversation.id, NULL::BIGINT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT l.id INTO v_lead
  FROM leads l
  WHERE l.deleted_at IS NULL
    AND (l.id = v_conversation.lead_id OR l.source_conversation_id = v_conversation.id)
    AND crm_lead_conversation_id(l.id) = v_conversation.id
  ORDER BY l.id DESC
  LIMIT 1;

  RETURN QUERY SELECT CASE WHEN v_lead IS NULL THEN 'no_lead' ELSE 'ok' END,
    v_conversation.id, v_lead, v_routed;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. chat.take / chat.release by conversation_id
-- -----------------------------------------------------------------------------
-- crm_inbound_apply_chat_event() (040) step by step, with two differences:
--   * the lead comes from crm_inbound_handoff_conversation() instead of
--     leads.crm_opportunity_id (422 unknown_conversation instead of
--     invalid_opportunity);
--   * a live lease without owner_seller_id is held by the handoff's routed
--     seller, where the opportunity path uses the lead's assigned seller.
-- Same inbox, locks, stale-version rule, holder conflict, 2-hour window,
-- expired-lease release, audit rows and version trigger.
CREATE OR REPLACE FUNCTION crm_inbound_apply_conversation_chat_event(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_event_type TEXT,
  p_conversation_ref TEXT,
  p_conversation_id BIGINT,
  p_seller_id UUID,
  p_ownership_version BIGINT
)
RETURNS TABLE (http_status INTEGER, response JSONB, replayed BOOLEAN)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_stored crm_inbound_events%ROWTYPE;
  v_resolved RECORD;
  v_lead leads%ROWTYPE;
  v_seller sellers%ROWTYPE;
  v_active lead_chat_ownerships%ROWTYPE;
  v_has_active BOOLEAN := FALSE;
  v_live BOOLEAN := FALSE;
  v_conversation BIGINT;
  v_current BIGINT;
  v_holder BIGINT;
  v_status INTEGER;
  v_response JSONB;
  v_message_id BIGINT;
  v_message_at TIMESTAMPTZ;
  v_new_id BIGINT;
BEGIN
  IF p_event_id IS NULL OR p_body_sha256 IS NULL OR p_event_type IS NULL
     OR p_event_type NOT IN ('chat.take', 'chat.release')
     OR p_conversation_ref IS NULL OR p_seller_id IS NULL
     OR p_ownership_version IS NULL OR p_ownership_version < 0 THEN
    RAISE EXCEPTION 'crm_inbound_apply_conversation_chat_event: invalid arguments';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('crm-inbound-event:' || p_event_id, 0));

  SELECT e.* INTO v_stored FROM crm_inbound_events e WHERE e.event_id = p_event_id;
  IF FOUND THEN
    IF v_stored.body_sha256 = p_body_sha256 THEN
      RETURN QUERY SELECT v_stored.http_status, v_stored.response, TRUE;
    ELSE
      RETURN QUERY SELECT 409, jsonb_build_object('error', 'event_conflict', 'event_id', p_event_id), FALSE;
    END IF;
    RETURN;
  END IF;

  SELECT r.* INTO v_resolved FROM crm_inbound_handoff_conversation(p_conversation_ref, p_conversation_id) r;
  v_conversation := v_resolved.conversation_id;
  IF v_resolved.status = 'ok' THEN
    SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_resolved.lead_id;
  END IF;

  IF v_lead.id IS NULL THEN
    v_status := 422;
    v_response := jsonb_build_object('error', 'unknown_conversation', 'event_id', p_event_id);
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
      v_has_active := FOUND;
      v_live := v_has_active AND (v_active.response_due_at IS NULL OR v_active.response_due_at > NOW());

      SELECT cco.ownership_version INTO v_current
      FROM crm_conversation_ownership cco
      WHERE cco.conversation_id = v_conversation
      FOR UPDATE;
      v_current := COALESCE(v_current, 0);

      IF v_live THEN
        v_holder := COALESCE(v_active.owner_seller_id, v_resolved.routed_seller_id);
      END IF;

      IF p_ownership_version < v_current THEN
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'ignored_stale', 'ownership_version', v_current);
      ELSIF v_live AND v_holder IS DISTINCT FROM v_seller.id THEN
        v_status := 409;
        v_response := jsonb_build_object(
          'error', 'ownership_conflict',
          'holder_crm_seller_id', (
            SELECT s.crm_user_id FROM sellers s WHERE s.id = v_holder AND s.deleted_at IS NULL
          ),
          'ownership_version', v_current
        );
      ELSIF p_event_type = 'chat.take' AND v_live THEN
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied', 'ownership_version', v_current);
      ELSIF p_event_type = 'chat.take' THEN
        IF v_has_active THEN
          UPDATE lead_chat_ownerships o
          SET released_at = NOW(),
              release_reason = 'sla_expired',
              restoration_state = CASE
                WHEN o.acquired_via = 'crm' OR o.clickup_task_id IS NULL THEN 'not_required'
                WHEN o.previous_clickup_status IS NOT NULL THEN 'pending'
                ELSE 'skipped_no_previous_status'
              END,
              restoration_claimed_at = CASE
                WHEN o.acquired_via IS NULL AND o.clickup_task_id IS NOT NULL
                     AND o.previous_clickup_status IS NOT NULL
                  THEN TIMESTAMPTZ 'epoch'
                ELSE o.restoration_claimed_at
              END,
              restoration_error = CASE
                WHEN o.acquired_via IS NULL AND o.clickup_task_id IS NOT NULL
                     AND o.previous_clickup_status IS NULL
                  THEN 'previous_clickup_status_missing: '
                    || 'el lease vencio sin evidencia del estado previo de ClickUp; '
                    || 'la restauracion requiere intervencion manual'
                ELSE o.restoration_error
              END,
              updated_at = NOW()
          WHERE o.id = v_active.id;

          INSERT INTO audit_logs (
            event_name, entity_type, entity_id, actor_type, actor_id,
            result, before_payload, after_payload, metadata
          ) VALUES (
            'lead_chat_ownership_sla_expiry', 'lead_chat_ownership', v_active.id, 'system',
            'crm-inbound-events', 'expired_before_crm_take',
            jsonb_build_object('response_due_at', v_active.response_due_at),
            jsonb_build_object('release_reason', 'sla_expired'),
            jsonb_build_object('lead_id', v_lead.id, 'crm_event_id', p_event_id)
          );
        END IF;

        SELECT m.id, m.created_at INTO v_message_id, v_message_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.deleted_at IS NULL
          AND m.direction = 'incoming'
          AND m.sender_type = 'customer'
          AND (m.lead_id = v_lead.id OR c.lead_id = v_lead.id OR m.conversation_id = v_conversation)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1;

        INSERT INTO lead_chat_ownerships (
          lead_id, clickup_task_id, previous_clickup_status, acquired_at,
          pending_message_id, pending_message_at, response_due_at,
          sla_mode, acquired_via, owner_seller_id
        ) VALUES (
          v_lead.id, NULL, NULL, NOW(),
          v_message_id, v_message_at,
          CASE WHEN v_message_id IS NOT NULL THEN NOW() + INTERVAL '2 hours' END,
          'standard', 'crm', v_seller.id
        )
        RETURNING id INTO v_new_id;

        INSERT INTO audit_logs (
          event_name, entity_type, entity_id, actor_type, actor_id,
          result, before_payload, after_payload, metadata
        ) VALUES (
          'lead_chat_ownership_acquisition', 'lead_chat_ownership', v_new_id, 'system',
          'crm-inbound-events', 'acquired',
          jsonb_build_object('ownership_id', v_active.id),
          jsonb_build_object('ownership_id', v_new_id, 'owner_seller_id', v_seller.id),
          jsonb_build_object('lead_id', v_lead.id, 'crm_event_id', p_event_id, 'crm_seller_id', p_seller_id,
                             'conversation_id', v_conversation)
        );

        SELECT cco.ownership_version INTO v_current
        FROM crm_conversation_ownership cco WHERE cco.conversation_id = v_conversation;
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied', 'ownership_version', COALESCE(v_current, 0));
      ELSIF v_live THEN
        UPDATE lead_chat_ownerships o
        SET released_at = NOW(),
            release_reason = 'manual',
            released_via = 'crm',
            restoration_state = 'not_required',
            updated_at = NOW()
        WHERE o.id = v_active.id;

        INSERT INTO audit_logs (
          event_name, entity_type, entity_id, actor_type, actor_id,
          result, before_payload, after_payload, metadata
        ) VALUES (
          'lead_chat_ownership_release', 'lead_chat_ownership', v_active.id, 'system',
          'crm-inbound-events', 'released',
          jsonb_build_object('released_at', NULL),
          jsonb_build_object('release_reason', 'manual', 'released_via', 'crm'),
          jsonb_build_object('lead_id', v_lead.id, 'crm_event_id', p_event_id, 'crm_seller_id', p_seller_id,
                             'conversation_id', v_conversation)
        );

        SELECT cco.ownership_version INTO v_current
        FROM crm_conversation_ownership cco WHERE cco.conversation_id = v_conversation;
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied', 'ownership_version', COALESCE(v_current, 0));
      ELSE
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'ignored_stale', 'ownership_version', v_current);
      END IF;
    END IF;
  END IF;

  INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
  VALUES (p_event_id, p_event_type, p_body_sha256, v_status, v_response, v_lead.id, v_conversation);

  RETURN QUERY SELECT v_status, v_response, FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. message.send by conversation_id
-- -----------------------------------------------------------------------------
-- crm_inbound_claim_message_send() (041) step by step: the same idempotency
-- (shared inbox and per-event_id lock, client_message_id uniqueness, 503 while
-- an attempt is 'sending' or 'unknown', a 'failed' intent claimed again), the
-- same ownership rule (the sender holds the chat -> send; the bot holds it ->
-- implicit take through crm_inbound_apply_conversation_chat_event() with the
-- synthetic id "message.send/<event_id>/take-<attempt>"; another seller holds
-- it -> 409 ownership_conflict) and the same claim. The conversation comes
-- from crm_inbound_handoff_conversation() (422 unknown_conversation) and the
-- intent records crm_conversation_ref instead of crm_opportunity_id.
CREATE OR REPLACE FUNCTION crm_inbound_claim_conversation_message_send(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_conversation_ref TEXT,
  p_conversation_id BIGINT,
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
  v_resolved RECORD;
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
     OR p_conversation_ref IS NULL OR p_seller_id IS NULL OR p_client_message_id IS NULL
     OR p_ownership_version IS NULL OR p_ownership_version < 0
     OR p_text IS NULL OR btrim(p_text) = '' OR char_length(p_text) > 4096 THEN
    RAISE EXCEPTION 'crm_inbound_claim_conversation_message_send: invalid arguments';
  END IF;

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

  SELECT r.* INTO v_resolved FROM crm_inbound_handoff_conversation(p_conversation_ref, p_conversation_id) r;
  v_conversation := v_resolved.conversation_id;
  IF v_resolved.status = 'ok' THEN
    SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_resolved.lead_id;
  END IF;

  IF v_lead.id IS NULL THEN
    v_status := 422;
    v_response := jsonb_build_object('error', 'unknown_conversation', 'event_id', p_event_id);
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
        v_holder := COALESCE(v_active.owner_seller_id, v_resolved.routed_seller_id);
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
          FROM crm_inbound_apply_conversation_chat_event(
            'message.send/' || p_event_id || '/take-' || v_attempt::text,
            p_body_sha256, 'chat.take', p_conversation_ref, p_conversation_id, p_seller_id, v_current
          ) t;
          IF v_take_status IS DISTINCT FROM 200 OR v_take_response->>'result' IS DISTINCT FROM 'applied' THEN
            RAISE EXCEPTION 'crm_inbound_claim_conversation_message_send: implicit take not applied (%)', v_take_status;
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
            event_id, client_message_id, body_sha256, crm_opportunity_id, crm_conversation_ref, crm_seller_id,
            seller_id, lead_id, conversation_id, phone_number, instance_name, text_body,
            status, attempt_count, ownership_version
          ) VALUES (
            p_event_id, p_client_message_id, p_body_sha256, NULL, p_conversation_ref, p_seller_id,
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

  IF NOT v_has_stored THEN
    INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
    VALUES (p_event_id, 'message.send', p_body_sha256, v_status, v_response, v_lead.id, v_conversation);
  END IF;

  RETURN QUERY SELECT v_status, v_response, FALSE,
    FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. handoff.acknowledged / handoff.resolved
-- -----------------------------------------------------------------------------
-- The transitions of handoff-routing/05_close_handoff_from_clickup.sql, with
-- the handoff named by the CRM instead of a ClickUp task:
--   notified -> acknowledged; notified | acknowledged -> resolved.
--   A 'pending' handoff counts as notified: its delivered handoff.created is
--   the proof that the CRM (the area) was notified.
--   The state already reached -> 200 duplicate, nothing written or audited.
--   Anything else (acknowledged after resolved) -> 409 invalid_transition,
--   audited like 05 audits a rejected transition.
--   resolved also resolves every other open handoff of the conversation (a
--   re-escalation the CRM keeps under this one) and closes the conversation
--   when it is still 'escalation_required', as 05 does.
--   p_handoff_id NULL (not our id) or no delivered handoff.created for it ->
--   422 unknown_handoff.
-- Idempotent through crm_inbound_events like the chat events: the same
-- event_id and bytes replay the stored answer; other bytes -> 409
-- event_conflict. crm_seller_id (the acting CRM user) is recorded in the audit
-- row; the CRM authorizes it (routed seller or admin).
CREATE OR REPLACE FUNCTION crm_inbound_apply_handoff_event(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_event_type TEXT,
  p_handoff_id BIGINT,
  p_seller_id UUID
)
RETURNS TABLE (http_status INTEGER, response JSONB, replayed BOOLEAN)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_stored crm_inbound_events%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_requested TEXT;
  v_outcome TEXT;
  v_status INTEGER;
  v_response JSONB;
  v_others BIGINT[] := ARRAY[]::BIGINT[];
  v_closed BOOLEAN := FALSE;
BEGIN
  IF p_event_id IS NULL OR p_body_sha256 IS NULL OR p_seller_id IS NULL
     OR p_event_type IS NULL OR p_event_type NOT IN ('handoff.acknowledged', 'handoff.resolved') THEN
    RAISE EXCEPTION 'crm_inbound_apply_handoff_event: invalid arguments';
  END IF;
  v_requested := CASE p_event_type WHEN 'handoff.acknowledged' THEN 'acknowledged' ELSE 'resolved' END;

  PERFORM pg_advisory_xact_lock(hashtextextended('crm-inbound-event:' || p_event_id, 0));

  SELECT e.* INTO v_stored FROM crm_inbound_events e WHERE e.event_id = p_event_id;
  IF FOUND THEN
    IF v_stored.body_sha256 = p_body_sha256 THEN
      RETURN QUERY SELECT v_stored.http_status, v_stored.response, TRUE;
    ELSE
      RETURN QUERY SELECT 409, jsonb_build_object('error', 'event_conflict', 'event_id', p_event_id), FALSE;
    END IF;
    RETURN;
  END IF;

  -- Locked like 05: two closure events for one handoff serialize, and the
  -- second one classifies against the state the first one committed.
  SELECT h.* INTO v_handoff
  FROM handoffs h
  WHERE h.id = p_handoff_id
    AND h.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.handoff_id = h.id
        AND e.event_type = 'handoff.created'
        AND e.status = 'delivered'
    )
  FOR UPDATE;

  IF v_handoff.id IS NULL THEN
    v_status := 422;
    v_response := jsonb_build_object('error', 'unknown_handoff', 'event_id', p_event_id);
  ELSE
    v_outcome := CASE
      WHEN v_handoff.estado = v_requested THEN 'already_applied'
      WHEN v_requested = 'acknowledged' AND v_handoff.estado IN ('pending', 'notified') THEN 'advanced'
      WHEN v_requested = 'resolved' AND v_handoff.estado IN ('pending', 'notified', 'acknowledged') THEN 'advanced'
      ELSE 'invalid_transition'
    END;

    IF v_outcome = 'advanced' THEN
      UPDATE handoffs h
      SET estado = v_requested,
          acknowledged_at = CASE
            WHEN v_requested = 'acknowledged' AND h.acknowledged_at IS NULL THEN NOW()
            ELSE h.acknowledged_at
          END,
          resolved_at = CASE
            WHEN v_requested = 'resolved' AND h.resolved_at IS NULL THEN NOW()
            ELSE h.resolved_at
          END,
          updated_at = NOW()
      WHERE h.id = v_handoff.id;

      IF v_requested = 'resolved' THEN
        WITH resolved_others AS (
          UPDATE handoffs h
          SET estado = 'resolved',
              resolved_at = COALESCE(h.resolved_at, NOW()),
              updated_at = NOW()
          WHERE h.conversation_id = v_handoff.conversation_id
            AND h.id <> v_handoff.id
            AND h.deleted_at IS NULL
            AND h.estado IN ('pending', 'notified', 'acknowledged')
          RETURNING h.id, h.estado
        )
        SELECT COALESCE(array_agg(r.id ORDER BY r.id), ARRAY[]::BIGINT[]) INTO v_others FROM resolved_others r;

        UPDATE conversations c
        SET conversation_status_id = (SELECT s.id FROM conversation_statuses s WHERE s.code = 'closed'),
            closed_at = COALESCE(c.closed_at, NOW()),
            updated_at = NOW()
        WHERE c.id = v_handoff.conversation_id
          AND c.deleted_at IS NULL
          AND c.conversation_status_id = (
            SELECT s.id FROM conversation_statuses s WHERE s.code = 'escalation_required'
          );
        v_closed := FOUND;
      END IF;

      v_status := 200;
      v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied');
    ELSIF v_outcome = 'already_applied' THEN
      v_status := 200;
      v_response := jsonb_build_object('event_id', p_event_id, 'result', 'duplicate');
    ELSE
      v_status := 409;
      v_response := jsonb_build_object('error', 'invalid_transition', 'event_id', p_event_id);
    END IF;

    IF v_outcome <> 'already_applied' THEN
      INSERT INTO audit_logs (
        event_name, entity_type, entity_id, actor_type, actor_id,
        result, before_payload, after_payload, metadata
      ) VALUES (
        'handoff_transition', 'handoff', v_handoff.id, 'system', 'crm-inbound-events',
        v_outcome,
        jsonb_build_object('estado', v_handoff.estado),
        jsonb_build_object('estado', CASE WHEN v_outcome = 'advanced' THEN v_requested ELSE v_handoff.estado END),
        jsonb_build_object(
          'requested', v_requested,
          'crm_event_id', p_event_id,
          'crm_seller_id', p_seller_id,
          'conversation_closed', v_closed,
          'resolved_handoff_ids', to_jsonb(v_others)
        )
      );
    END IF;
  END IF;

  INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
  VALUES (p_event_id, p_event_type, p_body_sha256, v_status, v_response, NULL, v_handoff.conversation_id);

  RETURN QUERY SELECT v_status, v_response, FALSE;
END;
$$;

COMMIT;
