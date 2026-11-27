-- Rollback of migration 058 (1.3 chat actions by customer and
-- contact.opportunity_linked).
-- First re-import a crm-inbound-events workflow without the 1.3 branches and
-- whose Complete CRM Message Send calls crm_inbound_complete_message_send()
-- (pre-058 03_complete_crm_message_send.sql), and a crm-events-dispatcher
-- whose Select Handoff Candidates calls crm_route_handoff() and whose Select
-- Lead Qualified Candidates does not read the link (pre-058 01 and 09), or
-- switch CRM_EVENTS_PROTOCOL_REVISION back to 1.2 (the inbound 1.3 rules then
-- answer 400 and the 058 functions are no longer called) before dropping them.
-- crm_inbound_handoff_conversation() is restored verbatim from 050. The links
-- (crm_contacts.crm_opportunity_*) and crm_outbound_messages.contact_id are
-- dropped; handoffs already routed by a link keep their stored routing, and
-- inbox rows keep their stored answers.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS crm_route_contact_handoff(BIGINT, BIGINT);
DROP FUNCTION IF EXISTS crm_inbound_complete_contact_message_send(BIGINT, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS crm_inbound_claim_contact_message_send(TEXT, TEXT, UUID, TEXT, BIGINT, TEXT, BIGINT, TEXT, UUID, UUID, BIGINT, TEXT);
DROP FUNCTION IF EXISTS crm_inbound_apply_contact_event(TEXT, TEXT, TEXT, UUID, TEXT, BIGINT, TEXT, BIGINT, TEXT, UUID, BIGINT);
DROP FUNCTION IF EXISTS crm_contact_latest_conversation_id(BIGINT, TEXT);
DROP FUNCTION IF EXISTS crm_inbound_resolve_contact(UUID, TEXT, BIGINT, TEXT, BIGINT);

-- Verbatim from migration 050.
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

  IF NOT COALESCE(v_handed, FALSE) THEN
    RETURN QUERY SELECT 'unknown'::TEXT, v_conversation.id, NULL::BIGINT, NULL::BIGINT;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::TEXT, v_conversation.id,
    contact_latest_lead_id(v_conversation.source_number_id, v_conversation.phone_number),
    v_routed;
END;
$$;

DROP FUNCTION IF EXISTS crm_contact_open_link(BIGINT);

ALTER TABLE crm_outbound_messages DROP COLUMN IF EXISTS contact_id;
DROP INDEX IF EXISTS uq_crm_contacts_opportunity;
ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS chk_crm_contacts_opportunity_link;
ALTER TABLE crm_contacts
  DROP COLUMN IF EXISTS crm_opportunity_linked_at,
  DROP COLUMN IF EXISTS crm_opportunity_seller_id,
  DROP COLUMN IF EXISTS crm_opportunity_id;

COMMIT;
