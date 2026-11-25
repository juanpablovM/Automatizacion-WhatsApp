-- CRM 1.2d: chat ownership for a conversation handed off to the CRM whose
-- customer has no lead.
--
-- Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S8, S5).
--
-- Until 046 such a conversation answered chat.take / chat.release /
-- message.send with 422 unknown_conversation: chat ownership
-- (lead_chat_ownerships) was keyed by lead. A lead is never created for it:
-- any new lead becomes a CRM opportunity (lead.qualified). Instead, the same
-- table holds a conversation-keyed row, with the same effects as a lead-keyed
-- one (bot silent while the seller holds it, 2-hour response window, lease
-- expiry, release restores the bot, ownership.taken / ownership.released).
--
-- 1. lead_chat_ownerships.conversation_id; lead_id nullable; at least one of
--    the two; one live row per conversation. conversation_id alone: the
--    contact has no lead. Both: a lead lease the CRM took on a conversation
--    that is not the lead's own (a re-engaged conversation that inherited an
--    older lead), tracked under that conversation. Every lead-keyed path (ClickUp
--    01/02/09-12, ON CONFLICT (lead_id), uq_lead_chat_ownerships_active_lead)
--    is unchanged: ClickUp never writes a conversation-keyed row.
-- 2. crm_track_lead_chat_ownership() (040): a conversation-keyed row tracks
--    its own conversation.
-- 3. crm_inbound_handoff_conversation() (046): the lead is the contact's
--    latest lead (contact_latest_lead_id(), the orchestrator's latest_lead),
--    the one the bot's silence reads; 'ok' with lead_id NULL only when the
--    contact has no lead at all (was 'no_lead').
-- 4. crm_inbound_apply_conversation_chat_event() and
--    crm_inbound_claim_conversation_message_send() (046): without a lead the
--    live row is found / inserted by conversation_id, under the same
--    chat-authority lock (the conversation's source number and phone). The
--    resolution is repeated under that lock, so a lead committed meanwhile is
--    used instead.
-- 5. crm_inbound_complete_message_send() (041): without a lead, the same lock
--    by the conversation and the pending message cleared on its row.
-- 6. inbound_contact_seller_owned() (042): the orchestrator's new reading, the
--    latest ownership of the contact's latest lead OR of its latest
--    conversation (01_load_active_context.sql latest_chat_ownership).
-- 7. Lead created later for the conversation: an AFTER INSERT trigger on leads
--    moves the conversation's live row onto the new lead (lead_id set,
--    conversation_id cleared) in the lead's own transaction, under the
--    chat-authority lock, so there is never more than one live owner. The move
--    is not an ownership change: no version, no ownership event.
--
-- The orchestrator (01, 07), the outbound authority (05) and the seller-phone
-- reply (04) read the conversation-keyed row through their own queries.
--
-- Down migration: infra/postgres/rollback/047_conversation_chat_ownership.down.sql
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Conversation-keyed ownership
-- -----------------------------------------------------------------------------
ALTER TABLE lead_chat_ownerships
  ADD COLUMN IF NOT EXISTS conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE lead_chat_ownerships ALTER COLUMN lead_id DROP NOT NULL;

ALTER TABLE lead_chat_ownerships DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_holder;
ALTER TABLE lead_chat_ownerships ADD CONSTRAINT chk_lead_chat_ownerships_holder CHECK (
  lead_id IS NOT NULL OR conversation_id IS NOT NULL
);

-- The contact's latest lead: latest_lead of the orchestrator's Load
-- Conversation State (01_load_active_context.sql), the lead whose ownership
-- the bot's silence reads.
CREATE OR REPLACE FUNCTION contact_latest_lead_id(
  p_source_number_id BIGINT,
  p_phone_number TEXT
)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT l.id
  FROM leads l
  JOIN lead_statuses ls ON ls.id = l.lead_status_id
  WHERE l.deleted_at IS NULL
    AND l.phone_number = p_phone_number
    AND p_source_number_id IS NOT NULL
    AND l.source_number_id = p_source_number_id
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 1
$$;

-- One live ownership per conversation, as uq_lead_chat_ownerships_active_lead
-- per lead (same predicate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_chat_ownerships_active_conversation
ON lead_chat_ownerships (conversation_id)
WHERE released_at IS NULL AND deleted_at IS NULL;

-- The latest ownership of a conversation (orchestrator, debounce, 04).
CREATE INDEX IF NOT EXISTS idx_lead_chat_ownerships_conversation
ON lead_chat_ownerships (conversation_id, id)
WHERE conversation_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Version tracking (040), conversation-keyed rows included
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_track_lead_chat_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_conversation BIGINT;
  v_kind TEXT;
  v_source TEXT;
  v_reason TEXT;
  v_seller BIGINT;
  v_version BIGINT;
BEGIN
  BEGIN
    v_conversation := COALESCE(NEW.conversation_id, crm_lead_conversation_id(NEW.lead_id));
    IF v_conversation IS NULL THEN
      RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
      v_kind := 'taken';
      v_reason := NULL;
      v_source := CASE WHEN NEW.acquired_via = 'crm' THEN 'crm' ELSE 'clickup' END;
      v_seller := COALESCE(
        NEW.owner_seller_id,
        (SELECT l.assigned_seller_id FROM leads l WHERE l.id = NEW.lead_id)
      );
    ELSE
      v_kind := 'released';
      v_reason := CASE NEW.release_reason
        WHEN 'sla_expired' THEN 'sla_expired'
        WHEN 'customer_new_quote' THEN 'customer_new_quote'
        ELSE 'seller_released'
      END;
      v_source := CASE
        WHEN NEW.released_via = 'crm' THEN 'crm'
        WHEN NEW.release_reason = 'clickup_released' THEN 'clickup'
        ELSE 'bot'
      END;
      v_seller := NULL;
    END IF;

    INSERT INTO crm_conversation_ownership AS cco (
      conversation_id, ownership_version, owner_kind, seller_id, source, reason,
      lead_id, ownership_id, changed_at
    ) VALUES (
      v_conversation, 1, CASE WHEN v_kind = 'taken' THEN 'seller' ELSE 'bot' END,
      v_seller, v_source, v_reason, NEW.lead_id, NEW.id, NOW()
    )
    ON CONFLICT (conversation_id) DO UPDATE SET
      ownership_version = cco.ownership_version + 1,
      owner_kind = EXCLUDED.owner_kind,
      seller_id = EXCLUDED.seller_id,
      source = EXCLUDED.source,
      reason = EXCLUDED.reason,
      lead_id = EXCLUDED.lead_id,
      ownership_id = EXCLUDED.ownership_id,
      changed_at = EXCLUDED.changed_at
    RETURNING cco.ownership_version INTO v_version;

    INSERT INTO crm_ownership_changes (
      conversation_id, ownership_version, change_kind, lead_id, ownership_id,
      seller_id, source, reason, raw_reason
    ) VALUES (
      v_conversation, v_version, v_kind, NEW.lead_id, NEW.id,
      v_seller, v_source, v_reason,
      CASE WHEN v_kind = 'released' THEN NEW.release_reason END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'crm ownership tracking skipped for lead_chat_ownerships id %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Conversation resolution (046)
-- -----------------------------------------------------------------------------
-- status:
--   'unknown'  no delivered handoff.created for this conversation_id, the
--              conversation does not exist, its newest delivered handoff was
--              routed by opportunity, or a live lead of the conversation has
--              an opportunity (the CRM must use crm_opportunity_id) ->
--              422 unknown_conversation;
--   'ok'       routed_seller_id is the seller of the newest delivered handoff
--              (handoffs.crm_routing_seller_id); lead_id is the contact's
--              latest lead (contact_latest_lead_id(): same phone and source
--              number as the conversation, what the bot's silence reads), or
--              NULL when the contact has no lead at all: the chat is then held
--              by a conversation-keyed ownership.
-- A lead belongs to the conversation when crm_lead_conversation_id() (040)
-- names it; such a lead, or the contact's latest lead, with an opportunity
-- -> 'unknown' (the CRM uses crm_opportunity_id).
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

  v_lead := contact_latest_lead_id(v_conversation.source_number_id, v_conversation.phone_number);
  IF EXISTS (SELECT 1 FROM leads l WHERE l.id = v_lead AND l.crm_opportunity_id IS NOT NULL) THEN
    RETURN QUERY SELECT 'unknown'::TEXT, v_conversation.id, NULL::BIGINT, NULL::BIGINT;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::TEXT, v_conversation.id, v_lead, v_routed;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4a. chat.take / chat.release by conversation_id (046)
-- -----------------------------------------------------------------------------
-- 046 step by step, with the lead of crm_inbound_handoff_conversation() (the
-- contact's latest lead). A lease taken on a lead whose own conversation is
-- another one also records conversation_id, so its versions and ownership
-- events follow the conversation the CRM knows. Without a lead, the live row
-- is the conversation's
-- (lead_chat_ownerships.conversation_id) and the chat-authority lock is taken
-- with the conversation's source number and phone; the resolution is then
-- repeated under the lock (a lead created meanwhile moved the row onto
-- itself, section 7, and is used). With a lead nothing changes.
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
  IF v_resolved.status = 'ok' AND v_resolved.lead_id IS NOT NULL THEN
    SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_resolved.lead_id;
  END IF;

  IF v_resolved.status IS DISTINCT FROM 'ok' THEN
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
      IF v_lead.id IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'chat-authority:' || c.source_number_id::text || ':' || c.phone_number, 0
        ))
        FROM conversations c
        WHERE c.id = v_conversation;

        SELECT r.* INTO v_resolved FROM crm_inbound_handoff_conversation(p_conversation_ref, p_conversation_id) r;
        IF v_resolved.lead_id IS NOT NULL THEN
          SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_resolved.lead_id;
        END IF;
      END IF;

      IF v_lead.id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'chat-authority:' || v_lead.source_number_id::text || ':' || v_lead.phone_number, 0
        ));
      END IF;

      SELECT o.* INTO v_active
      FROM lead_chat_ownerships o
      WHERE (CASE WHEN v_lead.id IS NOT NULL THEN o.lead_id = v_lead.id
                  ELSE o.conversation_id = v_conversation END)
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
          lead_id, conversation_id, clickup_task_id, previous_clickup_status, acquired_at,
          pending_message_id, pending_message_at, response_due_at,
          sla_mode, acquired_via, owner_seller_id
        ) VALUES (
          v_lead.id,
          CASE WHEN v_lead.id IS NULL OR crm_lead_conversation_id(v_lead.id) IS DISTINCT FROM v_conversation
            THEN v_conversation END,
          NULL, NULL, NOW(),
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
-- 4b. message.send by conversation_id (046)
-- -----------------------------------------------------------------------------
-- 046 step by step, with the lead / conversation rule of 4a. The intent's
-- lead_id is NULL without a lead.
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
  IF v_resolved.status = 'ok' AND v_resolved.lead_id IS NOT NULL THEN
    SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_resolved.lead_id;
  END IF;

  IF v_resolved.status IS DISTINCT FROM 'ok' THEN
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
      IF v_lead.id IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'chat-authority:' || c.source_number_id::text || ':' || c.phone_number, 0
        ))
        FROM conversations c
        WHERE c.id = v_conversation;

        SELECT r.* INTO v_resolved FROM crm_inbound_handoff_conversation(p_conversation_ref, p_conversation_id) r;
        IF v_resolved.lead_id IS NOT NULL THEN
          SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_resolved.lead_id;
        END IF;
      END IF;

      IF v_lead.id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'chat-authority:' || v_lead.source_number_id::text || ':' || v_lead.phone_number, 0
        ));
      END IF;

      SELECT o.* INTO v_active
      FROM lead_chat_ownerships o
      WHERE (CASE WHEN v_lead.id IS NOT NULL THEN o.lead_id = v_lead.id
                  ELSE o.conversation_id = v_conversation END)
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
-- 5. message.send completion (041)
-- -----------------------------------------------------------------------------
-- 041 for an intent with a lead, except that the conversation row is locked
-- before chat-authority (lock order shared with section 7). Without one (a conversation-keyed
-- chat), the chat-authority lock is the conversation's and the seller's reply
-- satisfies the live window of the conversation's row.
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

  -- Lock order: the conversation row first, then chat-authority, as a lead
  -- created for this conversation does (Persist Lead And Rotation updates the
  -- conversation row, then the leads trigger of section 7 takes
  -- chat-authority). The other order deadlocks with it.
  PERFORM 1 FROM conversations c WHERE c.id = v_outbound.conversation_id FOR NO KEY UPDATE;

  SELECT l.* INTO v_lead FROM leads l WHERE l.id = v_outbound.lead_id;
  IF v_lead.id IS NOT NULL THEN
    -- Same chat-authority lock as 04_register_human_reply.sql.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'chat-authority:' || v_lead.source_number_id::text || ':' || v_lead.phone_number, 0
    ));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'chat-authority:' || c.source_number_id::text || ':' || c.phone_number, 0
    ))
    FROM conversations c
    WHERE c.id = v_outbound.conversation_id;
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
  UPDATE lead_chat_ownerships o
  SET pending_message_id = NULL,
      pending_message_at = NULL,
      response_due_at = NULL,
      last_human_message_id = v_message_id,
      last_human_reply_at = NOW(),
      updated_at = NOW()
  WHERE (CASE WHEN v_lead.id IS NOT NULL THEN o.lead_id = v_lead.id
              ELSE o.conversation_id = v_outbound.conversation_id END)
    AND o.released_at IS NULL
    AND o.deleted_at IS NULL
    AND (o.response_due_at IS NULL OR o.response_due_at > NOW());

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

-- -----------------------------------------------------------------------------
-- 6. "A seller owns this chat" for the inbound queue (042)
-- -----------------------------------------------------------------------------
-- latest_lead, latest_conversation, latest_chat_ownership and
-- chat_authority.bot_suppressed of the orchestrator's Load Conversation State
-- (01_load_active_context.sql), for this contact: the newest ownership of the
-- contact's latest lead or of its latest conversation, minus the quote
-- follow-up mode, as in 042.
CREATE OR REPLACE FUNCTION inbound_contact_seller_owned(
  p_source_number_id BIGINT,
  p_phone_number TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT o.released_at IS NULL
      AND (o.response_due_at IS NULL OR o.response_due_at > NOW())
      AND o.sla_mode IS DISTINCT FROM 'quote_followup'
    FROM (
      SELECT ownership.id, ownership.released_at, ownership.response_due_at, ownership.sla_mode
      FROM lead_chat_ownerships ownership
      WHERE ownership.lead_id = contact_latest_lead_id(p_source_number_id, p_phone_number)
        AND ownership.deleted_at IS NULL
      UNION ALL
      SELECT ownership.id, ownership.released_at, ownership.response_due_at, ownership.sla_mode
      FROM lead_chat_ownerships ownership
      JOIN (
        SELECT c.id
        FROM conversations c
        JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
        WHERE c.deleted_at IS NULL
          AND c.phone_number = p_phone_number
          AND p_source_number_id IS NOT NULL
          AND c.source_number_id = p_source_number_id
        ORDER BY c.started_at DESC, c.id DESC
        LIMIT 1
      ) latest_conversation ON latest_conversation.id = ownership.conversation_id
      WHERE ownership.deleted_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    ) o
  ), FALSE);
$$;

-- -----------------------------------------------------------------------------
-- 7. A lead created for a conversation adopts its live ownership
-- -----------------------------------------------------------------------------
-- The live conversation-keyed row of the lead's source conversation becomes
-- the lead's (lead_id set, conversation_id cleared): from then on every
-- lead-keyed path sees the seller's lease. Not an acquisition or a release
-- (no released_at change), so no version and no ownership event. Released
-- conversation rows stay as history. A brand-new lead holds no ownership, so
-- the lead's live-row index cannot conflict. Taken under the chat-authority
-- lock, the one the CRM take of the conversation holds. Lock order: this
-- statement already updated the conversation row (linked_conversation), then
-- chat-authority; crm_inbound_complete_message_send() takes them in the same
-- order.
CREATE OR REPLACE FUNCTION crm_adopt_conversation_chat_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_conversation_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'chat-authority:' || NEW.source_number_id::text || ':' || NEW.phone_number, 0
  ));

  UPDATE lead_chat_ownerships o
  SET lead_id = NEW.id,
      conversation_id = NULL,
      updated_at = NOW()
  WHERE o.conversation_id = NEW.source_conversation_id
    AND o.lead_id IS NULL
    AND o.released_at IS NULL
    AND o.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM lead_chat_ownerships x
      WHERE x.lead_id = NEW.id AND x.released_at IS NULL AND x.deleted_at IS NULL
    );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_adopt_conversation_chat_ownership ON leads;
CREATE TRIGGER trg_crm_adopt_conversation_chat_ownership
AFTER INSERT ON leads
FOR EACH ROW
WHEN (NEW.source_conversation_id IS NOT NULL)
EXECUTE FUNCTION crm_adopt_conversation_chat_ownership();

COMMIT;
