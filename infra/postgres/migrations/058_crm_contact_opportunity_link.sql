-- CRM 1.3 (U7, S6-S8): chat actions keyed by customer and
-- contact.opportunity_linked.
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (S6, S7, S8).
-- Contract: .orca/drops/whatsapp-events-1.3-crm-response.md §4.1-§4.4 and
-- .orca/drops/whatsapp-events-1.3-bot-reply.md §2.
--
-- Everything here is used only by requests with protocol_revision "1.3" (the
-- workflow routes them to the new functions); 1.1/1.2 requests keep calling
-- the 049/050/051 functions, whose behaviour does not change. The only shared
-- objects that change are:
--   * crm_inbound_handoff_conversation() (050): identical unless the
--     transaction-local setting crm.inbound_contact_scope is 'on', which only
--     the 1.3 functions below set around their call;
--   * the handoff routing of the dispatcher (09) goes through
--     crm_route_contact_handoff(), which is crm_route_handoff() (051) unless
--     the customer has an open linked opportunity. A link exists only after a
--     1.3 contact.opportunity_linked, so without 1.3 nothing changes.
--
-- 1. crm_contacts.crm_opportunity_id / crm_opportunity_seller_id /
--    crm_opportunity_linked_at: the opportunity the CRM linked to the
--    customer (one contact per opportunity). crm_outbound_messages.contact_id
--    marks a 1.3 message.send (its completion answers the contact counter).
-- 2. crm_contact_open_link(contact): the link while it is open. A link ends
--    when a handoff of that customer that carried the linked opportunity is
--    resolved (handoff.resolved, or the bot's own closure) after the link and
--    no open handoff carries it any more; a new link for another opportunity
--    is then accepted, and the same opportunity can be linked again.
-- 3. crm_inbound_resolve_contact(): any of the three identities to the
--    customer (contact) it names.
-- 4. crm_inbound_apply_contact_event(): 1.3 chat.take / chat.release (S6, S8)
--    and contact.opportunity_linked (S7). Chat actions act on the customer:
--    under the customer's chat-authority lock they call the 1.2d conversation
--    path (crm_inbound_apply_conversation_chat_event, 051) on the customer's
--    latest conversation, with crm.inbound_contact_scope on, so any active
--    seller or CRM admin may act on any conversation (no handoff needed) and
--    the open link's seller is the routed seller of the holder rule. The
--    lease, holder and conflict rules are the 051 ones, unchanged. The stale
--    check and every ownership_version answered use crm_contacts.
--    ownership_version (056): a stale request changes nothing (the call runs
--    inside a subtransaction that is rolled back) and answers its 409 / 422
--    when the chat is held by someone else or the seller is invalid, else
--    200 ignored_stale. The inner call keeps its own inbox row under
--    '1.3/<event_id>'.
-- 5. crm_inbound_claim_contact_message_send() / crm_inbound_complete_contact_
--    message_send(): message.send by any identity through the 051
--    conversation claim and the 047 completion, answering the contact counter.
-- 6. crm_route_contact_handoff(): a handoff of a customer with an open link is
--    routed to the linked opportunity (before re-escalation, the lead's
--    opportunity, the test seller and the rotation of 051); otherwise 051.
--
-- Lock order: crm-inbound-event, (crm-message-send-client), chat-authority,
-- then the 051 locks; crm_contacts rows are never locked before
-- crm_conversation_ownership (056's order), except by
-- contact.opportunity_linked, which locks only its contact row.
--
-- Down migration: infra/postgres/rollback/058_crm_contact_opportunity_link.down.sql
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS crm_opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS crm_opportunity_seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS crm_opportunity_linked_at TIMESTAMPTZ;
ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS chk_crm_contacts_opportunity_link;
ALTER TABLE crm_contacts ADD CONSTRAINT chk_crm_contacts_opportunity_link CHECK (
  (crm_opportunity_id IS NULL) = (crm_opportunity_linked_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contacts_opportunity
ON crm_contacts (crm_opportunity_id)
WHERE crm_opportunity_id IS NOT NULL;

ALTER TABLE crm_outbound_messages
  ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES crm_contacts(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 2. The open link of a customer
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_contact_open_link(p_contact_id BIGINT)
RETURNS TABLE (crm_opportunity_id UUID, seller_id BIGINT, linked_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
AS $$
  SELECT ct.crm_opportunity_id, ct.crm_opportunity_seller_id, ct.crm_opportunity_linked_at
  FROM crm_contacts ct
  WHERE ct.id = p_contact_id
    AND ct.crm_opportunity_id IS NOT NULL
    AND NOT (
      EXISTS (
        SELECT 1
        FROM handoffs h
        JOIN conversations c ON c.id = h.conversation_id
        WHERE h.deleted_at IS NULL
          AND h.crm_opportunity_id = ct.crm_opportunity_id
          AND h.estado = 'resolved'
          AND h.resolved_at >= ct.crm_opportunity_linked_at
          AND COALESCE(h.source_number_id, c.source_number_id) = ct.source_number_id
          AND h.phone_number = ct.phone_number
      )
      AND NOT EXISTS (
        SELECT 1
        FROM handoffs h
        JOIN conversations c ON c.id = h.conversation_id
        WHERE h.deleted_at IS NULL
          AND h.crm_opportunity_id = ct.crm_opportunity_id
          AND h.estado IN ('pending', 'notified', 'acknowledged')
          AND COALESCE(h.source_number_id, c.source_number_id) = ct.source_number_id
          AND h.phone_number = ct.phone_number
      )
    )
$$;

-- -----------------------------------------------------------------------------
-- 3. Conversation resolution (050) with the 1.3 customer scope
-- -----------------------------------------------------------------------------
-- Verbatim 050 unless crm.inbound_contact_scope = 'on' (transaction-local, set
-- only by the 1.3 functions of this migration): then every live conversation
-- with a contact is 'ok' (S6: any customer, any time, no handoff needed), and
-- the routed seller is the open link's seller (S7), else the newest delivered
-- handoff's.
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
  v_handed BOOLEAN := FALSE;
  v_link_seller BIGINT;
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

  SELECT TRUE, h.crm_routing_seller_id INTO v_handed, v_routed
  FROM crm_events e
  JOIN handoffs h ON h.id = e.handoff_id AND h.deleted_at IS NULL
  WHERE e.event_type = 'handoff.created'
    AND e.status = 'delivered'
    AND e.conversation_id = p_conversation_ref
    AND h.conversation_id = v_conversation.id
  ORDER BY e.id DESC
  LIMIT 1;

  IF current_setting('crm.inbound_contact_scope', TRUE) = 'on' THEN
    SELECT lk.seller_id INTO v_link_seller
    FROM crm_contact_open_link(crm_contact_ref(v_conversation.source_number_id, v_conversation.phone_number)) lk;
    RETURN QUERY SELECT 'ok'::TEXT, v_conversation.id,
      contact_latest_lead_id(v_conversation.source_number_id, v_conversation.phone_number),
      COALESCE(v_link_seller, v_routed);
    RETURN;
  END IF;

  IF NOT COALESCE(v_handed, FALSE) THEN
    RETURN QUERY SELECT 'unknown'::TEXT, v_conversation.id, NULL::BIGINT, NULL::BIGINT;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::TEXT, v_conversation.id,
    contact_latest_lead_id(v_conversation.source_number_id, v_conversation.phone_number),
    v_routed;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Identity -> customer
-- -----------------------------------------------------------------------------
-- Exactly one of the three identities (the workflow validated the shape):
--   crm_opportunity_id: the newest live lead carrying it, else a contact
--     linked to it -> its contact; none -> 'invalid_opportunity';
--   conversation_id: a live conversation of ours -> its contact; none (or
--     another prefix: p_conversation_id NULL) -> 'unknown_conversation';
--   contact_id: the contact; none (or another prefix) -> 'unknown_contact'.
-- A customer without a live conversation answers the identity's error.
CREATE OR REPLACE FUNCTION crm_inbound_resolve_contact(
  p_opportunity_id UUID,
  p_conversation_ref TEXT,
  p_conversation_id BIGINT,
  p_contact_ref TEXT,
  p_contact_id BIGINT
)
RETURNS TABLE (status TEXT, contact_id BIGINT, source_number_id BIGINT, phone_number TEXT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_contact crm_contacts%ROWTYPE;
  v_error TEXT;
  v_id BIGINT;
BEGIN
  IF p_contact_ref IS NOT NULL THEN
    v_error := 'unknown_contact';
    v_id := p_contact_id;
  ELSIF p_conversation_ref IS NOT NULL THEN
    v_error := 'unknown_conversation';
    IF p_conversation_id IS NOT NULL THEN
      SELECT crm_contact_ensure(c.source_number_id, c.phone_number) INTO v_id
      FROM conversations c
      WHERE c.id = p_conversation_id AND c.deleted_at IS NULL;
    END IF;
  ELSE
    v_error := 'invalid_opportunity';
    IF p_opportunity_id IS NOT NULL THEN
      SELECT crm_contact_ensure(l.source_number_id, l.phone_number) INTO v_id
      FROM leads l
      WHERE l.crm_opportunity_id = p_opportunity_id
        AND l.deleted_at IS NULL
      ORDER BY l.id DESC
      LIMIT 1;
      IF v_id IS NULL THEN
        SELECT ct.id INTO v_id FROM crm_contacts ct WHERE ct.crm_opportunity_id = p_opportunity_id;
      END IF;
    END IF;
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT ct.* INTO v_contact FROM crm_contacts ct WHERE ct.id = v_id;
  END IF;
  IF v_contact.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.source_number_id = v_contact.source_number_id
      AND c.phone_number = v_contact.phone_number
      AND c.deleted_at IS NULL
  ) THEN
    RETURN QUERY SELECT v_error, NULL::BIGINT, NULL::BIGINT, NULL::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::TEXT, v_contact.id, v_contact.source_number_id, v_contact.phone_number;
END;
$$;

-- The customer's latest live conversation: latest_conversation of the
-- orchestrator (same order as inbound_contact_seller_owned, 047).
CREATE OR REPLACE FUNCTION crm_contact_latest_conversation_id(p_source_number_id BIGINT, p_phone TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT c.id
  FROM conversations c
  WHERE c.deleted_at IS NULL
    AND c.phone_number = p_phone
    AND p_source_number_id IS NOT NULL
    AND c.source_number_id = p_source_number_id
  ORDER BY c.started_at DESC, c.id DESC
  LIMIT 1
$$;

-- -----------------------------------------------------------------------------
-- 5. chat.take / chat.release / contact.opportunity_linked (1.3)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_inbound_apply_contact_event(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_event_type TEXT,
  p_opportunity_id UUID,
  p_conversation_ref TEXT,
  p_conversation_id BIGINT,
  p_contact_ref TEXT,
  p_contact_id BIGINT,
  p_id_prefix TEXT,
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
  v_contact crm_contacts%ROWTYPE;
  v_link RECORD;
  v_seller sellers%ROWTYPE;
  v_conversation BIGINT;
  v_lead BIGINT;
  v_before BIGINT;
  v_after BIGINT;
  v_status INTEGER;
  v_response JSONB;
  v_inner_status INTEGER;
  v_inner_response JSONB;
BEGIN
  IF p_event_id IS NULL OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
     OR p_event_type IS NULL
     OR p_event_type NOT IN ('chat.take', 'chat.release', 'contact.opportunity_linked')
     OR p_id_prefix IS NULL OR p_id_prefix !~ '^[a-z0-9]{1,16}$'
     OR p_seller_id IS NULL
     OR (p_event_type <> 'contact.opportunity_linked'
         AND (num_nonnulls(p_opportunity_id, p_conversation_ref, p_contact_ref) <> 1
              OR p_ownership_version IS NULL OR p_ownership_version < 0))
     OR (p_event_type = 'contact.opportunity_linked'
         AND (p_contact_ref IS NULL OR p_opportunity_id IS NULL OR p_conversation_ref IS NOT NULL)) THEN
    RAISE EXCEPTION 'crm_inbound_apply_contact_event: invalid arguments';
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

  IF p_event_type = 'contact.opportunity_linked' THEN
    -- S7. Only this contact row is locked (concurrent links of one customer
    -- serialize here; the unique index serializes one opportunity).
    IF p_contact_id IS NOT NULL THEN
      SELECT ct.* INTO v_contact FROM crm_contacts ct WHERE ct.id = p_contact_id FOR UPDATE;
    END IF;
    IF v_contact.id IS NOT NULL THEN
      SELECT s.* INTO v_seller
      FROM sellers s
      WHERE s.crm_user_id = p_seller_id
        AND s.deleted_at IS NULL
        AND (s.is_active OR s.crm_is_admin)
      LIMIT 1;
      SELECT lk.* INTO v_link FROM crm_contact_open_link(v_contact.id) lk;
    END IF;

    IF v_contact.id IS NULL THEN
      v_status := 422;
      v_response := jsonb_build_object('error', 'unknown_contact', 'event_id', p_event_id);
    ELSIF v_seller.id IS NULL THEN
      v_status := 422;
      v_response := jsonb_build_object('error', 'invalid_seller', 'event_id', p_event_id);
    ELSIF (v_link.crm_opportunity_id IS NOT NULL AND v_link.crm_opportunity_id <> p_opportunity_id)
       OR EXISTS (
         SELECT 1 FROM crm_contacts o
         WHERE o.crm_opportunity_id = p_opportunity_id AND o.id <> v_contact.id
       )
       OR EXISTS (
         SELECT 1 FROM leads l
         WHERE l.crm_opportunity_id = p_opportunity_id
           AND l.deleted_at IS NULL
           AND (l.source_number_id IS DISTINCT FROM v_contact.source_number_id
                OR l.phone_number IS DISTINCT FROM v_contact.phone_number)
       ) THEN
      -- The customer holds another open opportunity, or this opportunity
      -- belongs to another customer.
      v_status := 409;
      v_response := jsonb_build_object('error', 'identity_conflict', 'event_id', p_event_id);
    ELSIF v_link.crm_opportunity_id = p_opportunity_id
          AND v_contact.crm_opportunity_seller_id IS NOT DISTINCT FROM v_seller.id THEN
      v_status := 200;
      v_response := jsonb_build_object('event_id', p_event_id, 'result', 'duplicate');
    ELSE
      UPDATE crm_contacts ct
      SET crm_opportunity_id = p_opportunity_id,
          crm_opportunity_seller_id = v_seller.id,
          crm_opportunity_linked_at = CASE
            WHEN v_link.crm_opportunity_id = p_opportunity_id THEN ct.crm_opportunity_linked_at
            ELSE NOW()
          END,
          updated_at = NOW()
      WHERE ct.id = v_contact.id;

      INSERT INTO audit_logs (
        event_name, entity_type, entity_id, actor_type, actor_id, result, before_payload, after_payload, metadata
      ) VALUES (
        'crm_contact_opportunity_linked', 'crm_contact', v_contact.id, 'system', 'crm-inbound-events', 'applied',
        jsonb_build_object('crm_opportunity_id', v_contact.crm_opportunity_id,
                           'seller_id', v_contact.crm_opportunity_seller_id),
        jsonb_build_object('crm_opportunity_id', p_opportunity_id, 'seller_id', v_seller.id),
        jsonb_build_object('crm_event_id', p_event_id, 'crm_seller_id', p_seller_id)
      );
      v_status := 200;
      v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied');
    END IF;

    INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
    VALUES (p_event_id, p_event_type, p_body_sha256, v_status, v_response,
            CASE WHEN v_contact.id IS NOT NULL
              THEN contact_latest_lead_id(v_contact.source_number_id, v_contact.phone_number) END,
            CASE WHEN v_contact.id IS NOT NULL
              THEN crm_contact_latest_conversation_id(v_contact.source_number_id, v_contact.phone_number) END);
    RETURN QUERY SELECT v_status, v_response, FALSE;
    RETURN;
  END IF;

  -- S6: chat.take / chat.release on the customer.
  SELECT r.* INTO v_resolved
  FROM crm_inbound_resolve_contact(p_opportunity_id, p_conversation_ref, p_conversation_id, p_contact_ref, p_contact_id) r;

  IF v_resolved.status IS DISTINCT FROM 'ok' THEN
    v_status := 422;
    v_response := jsonb_build_object('error', v_resolved.status, 'event_id', p_event_id);
  ELSE
    -- The lock every take/release of this customer holds (040-051), so the
    -- latest conversation and the counter below are read under it.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'chat-authority:' || v_resolved.source_number_id::text || ':' || v_resolved.phone_number, 0
    ));
    v_conversation := crm_contact_latest_conversation_id(v_resolved.source_number_id, v_resolved.phone_number);
    v_lead := contact_latest_lead_id(v_resolved.source_number_id, v_resolved.phone_number);
    SELECT ct.ownership_version INTO v_before FROM crm_contacts ct WHERE ct.id = v_resolved.contact_id;

    PERFORM set_config('crm.inbound_contact_scope', 'on', TRUE);
    IF p_ownership_version < v_before THEN
      -- Stale: nothing may change. Run the 051 decision and roll it back, so
      -- a chat held by someone else still answers its 409 (and an invalid
      -- seller its 422); anything else answers ignored_stale.
      BEGIN
        SELECT t.http_status, t.response INTO v_inner_status, v_inner_response
        FROM crm_inbound_apply_conversation_chat_event(
          '1.3/' || p_event_id, p_body_sha256, p_event_type,
          'wa-' || p_id_prefix || '-conversation-' || v_conversation::text, v_conversation,
          p_seller_id, 9223372036854775807
        ) t;
        RAISE EXCEPTION USING ERRCODE = 'CRM13', MESSAGE = 'crm_inbound_apply_contact_event: stale dry run';
      EXCEPTION WHEN SQLSTATE 'CRM13' THEN
        NULL;
      END;
      IF v_inner_status IN (409, 422) THEN
        v_status := v_inner_status;
        v_response := v_inner_response;
      ELSE
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'ignored_stale', 'ownership_version', v_before);
      END IF;
    ELSE
      SELECT t.http_status, t.response INTO v_status, v_response
      FROM crm_inbound_apply_conversation_chat_event(
        '1.3/' || p_event_id, p_body_sha256, p_event_type,
        'wa-' || p_id_prefix || '-conversation-' || v_conversation::text, v_conversation,
        p_seller_id, 9223372036854775807
      ) t;
    END IF;
    PERFORM set_config('crm.inbound_contact_scope', '', TRUE);

    -- S8: the customer's counter (056), after any change made above.
    SELECT ct.ownership_version INTO v_after FROM crm_contacts ct WHERE ct.id = v_resolved.contact_id;
    IF v_response ? 'event_id' THEN
      v_response := v_response || jsonb_build_object('event_id', p_event_id);
    END IF;
    IF v_response ? 'ownership_version' THEN
      v_response := v_response || jsonb_build_object('ownership_version', v_after);
    END IF;
  END IF;

  INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
  VALUES (p_event_id, p_event_type, p_body_sha256, v_status, v_response, v_lead, v_conversation);

  RETURN QUERY SELECT v_status, v_response, FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. message.send (1.3)
-- -----------------------------------------------------------------------------
-- The 051 conversation claim on the customer's latest conversation (scope on),
-- with the real event_id: idempotency, the implicit take, the holder rule and
-- the intent are its own. A final answer carries the contact counter (also in
-- the stored inbox row); a claimed intent is marked with its contact, so the
-- completion answers the contact counter too.
CREATE OR REPLACE FUNCTION crm_inbound_claim_contact_message_send(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_opportunity_id UUID,
  p_conversation_ref TEXT,
  p_conversation_id BIGINT,
  p_contact_ref TEXT,
  p_contact_id BIGINT,
  p_id_prefix TEXT,
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
  v_stored BOOLEAN := FALSE;
  v_resolved RECORD;
  v_result RECORD;
  v_conversation BIGINT;
  v_counter BIGINT;
  v_response JSONB;
BEGIN
  IF p_event_id IS NULL OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
     OR num_nonnulls(p_opportunity_id, p_conversation_ref, p_contact_ref) <> 1
     OR p_id_prefix IS NULL OR p_id_prefix !~ '^[a-z0-9]{1,16}$'
     OR p_seller_id IS NULL OR p_client_message_id IS NULL
     OR p_ownership_version IS NULL OR p_ownership_version < 0
     OR p_text IS NULL OR btrim(p_text) = '' OR char_length(p_text) > 4096 THEN
    RAISE EXCEPTION 'crm_inbound_claim_contact_message_send: invalid arguments';
  END IF;

  -- The 051 claim's lock order: event, client message, then chat-authority.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-inbound-event:' || p_event_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-message-send-client:' || p_client_message_id::text, 0));
  v_stored := EXISTS (SELECT 1 FROM crm_inbound_events e WHERE e.event_id = p_event_id);

  SELECT r.* INTO v_resolved
  FROM crm_inbound_resolve_contact(p_opportunity_id, p_conversation_ref, p_conversation_id, p_contact_ref, p_contact_id) r;

  IF v_resolved.status IS DISTINCT FROM 'ok' AND NOT v_stored THEN
    IF EXISTS (SELECT 1 FROM crm_outbound_messages o WHERE o.client_message_id = p_client_message_id) THEN
      RETURN QUERY SELECT 409, jsonb_build_object('error', 'event_conflict', 'event_id', p_event_id), FALSE,
        FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    v_response := jsonb_build_object('error', v_resolved.status, 'event_id', p_event_id);
    INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
    VALUES (p_event_id, 'message.send', p_body_sha256, 422, v_response, NULL, NULL);
    RETURN QUERY SELECT 422, v_response, FALSE,
      FALSE, NULL::BIGINT, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_resolved.status = 'ok' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'chat-authority:' || v_resolved.source_number_id::text || ':' || v_resolved.phone_number, 0
    ));
    v_conversation := crm_contact_latest_conversation_id(v_resolved.source_number_id, v_resolved.phone_number);
  END IF;

  -- A stored event whose customer can no longer be resolved goes to the 051
  -- claim without a conversation: it replays, answers 503 while in flight, or
  -- (a retry of a failed send) answers 422 unknown_conversation.
  PERFORM set_config('crm.inbound_contact_scope', 'on', TRUE);
  SELECT c.* INTO v_result
  FROM crm_inbound_claim_conversation_message_send(
    p_event_id, p_body_sha256,
    COALESCE('wa-' || p_id_prefix || '-conversation-' || v_conversation::text, p_conversation_ref, p_contact_ref, 'none'),
    v_conversation, p_seller_id, p_client_message_id, p_ownership_version, p_text
  ) c;
  PERFORM set_config('crm.inbound_contact_scope', '', TRUE);

  IF v_result.send THEN
    UPDATE crm_outbound_messages o SET contact_id = v_resolved.contact_id WHERE o.id = v_result.outbound_id;
  ELSIF NOT v_result.replayed AND v_result.response ? 'ownership_version' AND v_resolved.status = 'ok' THEN
    SELECT ct.ownership_version INTO v_counter FROM crm_contacts ct WHERE ct.id = v_resolved.contact_id;
    v_response := v_result.response || jsonb_build_object('ownership_version', v_counter);
    UPDATE crm_inbound_events e
    SET response = v_response
    WHERE e.event_id = p_event_id
      AND e.response = v_result.response;
    v_result.response := v_response;
  END IF;

  RETURN QUERY SELECT v_result.http_status, v_result.response, v_result.replayed,
    v_result.send, v_result.outbound_id, v_result.attempt, v_result.phone_number,
    v_result.instance_name, v_result.text_body;
END;
$$;

-- The 047 completion for every intent (node 03). An intent claimed by 1.3
-- (contact_id set) that is completed now as sent answers, and stores, the
-- contact counter instead of the conversation's version; anything else is the
-- 047 answer unchanged.
CREATE OR REPLACE FUNCTION crm_inbound_complete_contact_message_send(
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
  v_fresh BOOLEAN := FALSE;
  v_status INTEGER;
  v_response JSONB;
  v_counter BIGINT;
BEGIN
  -- Same first lock as the 047 completion.
  IF p_outbound_id IS NOT NULL THEN
    SELECT o.* INTO v_outbound FROM crm_outbound_messages o WHERE o.id = p_outbound_id FOR UPDATE;
    v_fresh := FOUND AND v_outbound.contact_id IS NOT NULL AND v_outbound.status = 'sending'
      AND v_outbound.attempt_count = p_attempt;
  END IF;

  SELECT c.http_status, c.response INTO v_status, v_response
  FROM crm_inbound_complete_message_send(
    p_outbound_id, p_attempt, p_outcome, p_provider_message_id, p_provider_status, p_error, p_id_prefix
  ) c;

  IF v_fresh AND v_status = 200 AND v_response->>'result' = 'sent' THEN
    SELECT ct.ownership_version INTO v_counter FROM crm_contacts ct WHERE ct.id = v_outbound.contact_id;
    IF v_counter IS NOT NULL THEN
      v_response := v_response || jsonb_build_object('ownership_version', v_counter);
      UPDATE crm_inbound_events e SET response = v_response WHERE e.event_id = v_outbound.event_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_status, v_response;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Handoff routing with the linked opportunity (S7)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_route_contact_handoff(p_handoff_id BIGINT, p_test_seller_id BIGINT DEFAULT NULL)
RETURNS TABLE (crm_opportunity_id UUID, crm_routing_seller_id BIGINT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_handoff handoffs%ROWTYPE;
  v_contact BIGINT;
  v_opportunity UUID;
BEGIN
  -- crm_route_handoff's own locks, in its order (both are reentrant).
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-handoff-routing', 0));
  SELECT h.* INTO v_handoff
  FROM handoffs h
  WHERE h.id = p_handoff_id
    AND h.deleted_at IS NULL
  FOR UPDATE;

  IF FOUND AND v_handoff.crm_opportunity_id IS NULL AND v_handoff.crm_routing_seller_id IS NULL
     AND v_handoff.estado IN ('pending', 'notified', 'acknowledged') THEN
    SELECT crm_contact_ref(COALESCE(v_handoff.source_number_id, c.source_number_id), v_handoff.phone_number)
    INTO v_contact
    FROM conversations c
    WHERE c.id = v_handoff.conversation_id;
    SELECT lk.crm_opportunity_id INTO v_opportunity FROM crm_contact_open_link(v_contact) lk;
    IF v_opportunity IS NOT NULL THEN
      UPDATE handoffs h
      SET crm_opportunity_id = v_opportunity,
          crm_routing_seller_id = NULL
      WHERE h.id = v_handoff.id;
      RETURN QUERY SELECT v_opportunity, NULL::BIGINT;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT r.crm_opportunity_id, r.crm_routing_seller_id FROM crm_route_handoff(p_handoff_id, p_test_seller_id) r;
END;
$$;

COMMIT;
