-- Rollback of migration 046 (CRM inbound handoffs: conversation_id identity
-- and handoff.acknowledged / handoff.resolved). Drops the four functions and
-- the conversation identity of crm_outbound_messages. It fails if a
-- conversation-identified send exists (crm_opportunity_id NULL): delete or
-- reconcile those rows first. Restore the pre-046 crm-inbound-events workflow
-- first, or set CRM_INBOUND_HANDOFFS_ENABLED=false.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS crm_inbound_apply_handoff_event(TEXT, TEXT, TEXT, BIGINT, UUID);
DROP FUNCTION IF EXISTS crm_inbound_claim_conversation_message_send(TEXT, TEXT, TEXT, BIGINT, UUID, UUID, BIGINT, TEXT);
DROP FUNCTION IF EXISTS crm_inbound_apply_conversation_chat_event(TEXT, TEXT, TEXT, TEXT, BIGINT, UUID, BIGINT);
DROP FUNCTION IF EXISTS crm_inbound_handoff_conversation(TEXT, BIGINT);

ALTER TABLE crm_outbound_messages DROP CONSTRAINT IF EXISTS chk_crm_outbound_messages_identity;
ALTER TABLE crm_outbound_messages DROP COLUMN IF EXISTS crm_conversation_ref;
ALTER TABLE crm_outbound_messages ALTER COLUMN crm_opportunity_id SET NOT NULL;

COMMIT;
