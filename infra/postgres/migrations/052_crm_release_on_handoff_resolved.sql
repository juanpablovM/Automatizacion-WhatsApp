-- handoff.resolved gives the chat back to the bot.
--
-- CRM 1.2d close test (2026-11-26, odd/tasks/crm-1-2d-contingency-handoffs.md
-- S12, L30): the CRM admin took the chat implicitly with message.send by
-- conversation_id (a CRM lease on the customer's latest lead, response_due_at
-- NULL after the reply). handoff.resolved applied and closed the conversation,
-- but the lease stayed live: the bot stayed silent for the customer
-- indefinitely and the CRM got no ownership.released.
--
-- crm_inbound_apply_handoff_event() (046), same signature and responses: an
-- applied transition to 'resolved' also releases, in the same transaction, the
-- customer's live CRM-acquired lease (acquired_via 'crm') that the bot reads
-- for silence: lead-keyed on contact_latest_lead_id() when the customer has a
-- lead, conversation-keyed (047) on the handoff's conversation when not. The
-- release is chat.release's (released_at, release_reason 'manual',
-- released_via 'crm', restoration_state 'not_required', audit row), so the
-- 040 trigger records an ownership.released change the dispatcher maps to
-- seller_released. ClickUp leases are not touched; a duplicate resolved, an
-- acknowledged and a rejected transition change nothing. The transition's
-- audit row carries released_ownership_id (the released lease or null).
--
-- Down migration: infra/postgres/rollback/052_crm_release_on_handoff_resolved.down.sql
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

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
  v_source_number_id BIGINT;
  v_phone TEXT;
  v_lead_id BIGINT;
  v_lease lead_chat_ownerships%ROWTYPE;
  v_released BIGINT;
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

        -- 052: give the chat back to the bot. The customer's live lease that
        -- the bot reads for silence (the contact's latest lead, the
        -- conversation key without a lead, as the conversation path of
        -- 047/050 resolves it), when the CRM took it, is released exactly as
        -- chat.release releases it, so the 040 trigger records an
        -- ownership.released (seller_released) change. ClickUp leases and
        -- leases already past their response deadline (the SLA scheduler's)
        -- are left alone. Lock order: the conversation row (when the update
        -- above closed it) before chat-authority, as lead creation and
        -- crm_inbound_complete_message_send(); the lead is resolved under the
        -- lock, so a lead committed meanwhile is used.
        SELECT c.source_number_id, c.phone_number INTO v_source_number_id, v_phone
        FROM conversations c
        WHERE c.id = v_handoff.conversation_id;

        PERFORM pg_advisory_xact_lock(hashtextextended(
          'chat-authority:' || v_source_number_id::text || ':' || v_phone, 0
        ));
        v_lead_id := contact_latest_lead_id(v_source_number_id, v_phone);

        SELECT o.* INTO v_lease
        FROM lead_chat_ownerships o
        WHERE (CASE WHEN v_lead_id IS NOT NULL THEN o.lead_id = v_lead_id
                    ELSE o.conversation_id = v_handoff.conversation_id END)
          AND o.released_at IS NULL
          AND o.deleted_at IS NULL
        FOR UPDATE;

        IF FOUND AND v_lease.acquired_via = 'crm'
           AND (v_lease.response_due_at IS NULL OR v_lease.response_due_at > NOW()) THEN
          UPDATE lead_chat_ownerships o
          SET released_at = NOW(),
              release_reason = 'manual',
              released_via = 'crm',
              restoration_state = 'not_required',
              updated_at = NOW()
          WHERE o.id = v_lease.id;
          v_released := v_lease.id;

          INSERT INTO audit_logs (
            event_name, entity_type, entity_id, actor_type, actor_id,
            result, before_payload, after_payload, metadata
          ) VALUES (
            'lead_chat_ownership_release', 'lead_chat_ownership', v_lease.id, 'system',
            'crm-inbound-events', 'released',
            jsonb_build_object('released_at', NULL),
            jsonb_build_object('release_reason', 'manual', 'released_via', 'crm'),
            jsonb_build_object('lead_id', v_lease.lead_id, 'crm_event_id', p_event_id, 'crm_seller_id', p_seller_id,
                               'conversation_id', v_handoff.conversation_id, 'handoff_id', v_handoff.id)
          );
        END IF;
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
        ) || CASE
          WHEN v_requested = 'resolved' AND v_outcome = 'advanced'
            THEN jsonb_build_object('released_ownership_id', v_released)
          ELSE '{}'::jsonb
        END
      );
    END IF;
  END IF;

  INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
  VALUES (p_event_id, p_event_type, p_body_sha256, v_status, v_response, NULL, v_handoff.conversation_id);

  RETURN QUERY SELECT v_status, v_response, FALSE;
END;
$$;

COMMIT;
