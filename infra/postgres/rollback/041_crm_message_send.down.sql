-- Rollback of migration 041 (CRM -> bot message.send).
-- First set CRM_INBOUND_MESSAGE_SEND_ENABLED=false and re-import the previous
-- crm-inbound-events and crm-events-dispatcher workflows: the claim and
-- completion nodes call these functions, and the dispatcher's message
-- candidate query (05_select_message_candidates.sql) joins
-- crm_outbound_messages.
-- Destructive: the send intents are deleted. Messages already sent stay in
-- messages as outgoing seller ('human') messages; from then on message.new
-- attributes them to the lead's assigned seller. The message.send rows of
-- crm_inbound_events (final answers, provisional 503s and the implicit takes
-- "message.send/<event_id>/take-<n>") are deleted too, so a CRM retry of one
-- of those event_ids is evaluated from scratch; the ownership changes those
-- takes made stay, as any chat.take's would.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS crm_inbound_complete_message_send(BIGINT, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS crm_inbound_claim_message_send(TEXT, TEXT, UUID, UUID, UUID, BIGINT, TEXT);

DELETE FROM crm_inbound_events
WHERE event_type = 'message.send'
   OR event_id LIKE 'message.send/%';

DROP TABLE IF EXISTS crm_outbound_messages;

COMMIT;
