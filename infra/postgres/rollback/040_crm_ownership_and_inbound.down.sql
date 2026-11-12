-- Rollback of migration 040 (CRM revision 1.2b: ownership_version, ownership
-- events and the chat.take / chat.release webhook).
-- First set CRM_INBOUND_ENABLED=false (or deactivate crm-inbound-events) and
-- CRM_EVENTS_PROTOCOL_REVISION=1.1: both read and write these objects.
-- Destructive: ownership events in crm_events, the version history and the
-- inbound inbox are deleted. CRM-held ownership rows (acquired_via = 'crm')
-- have no ClickUp task; they are released before clickup_task_id becomes NOT
-- NULL again (the bot resumes those chats), then deleted, because the 018
-- schema cannot hold them.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

DROP FUNCTION IF EXISTS crm_inbound_apply_chat_event(TEXT, TEXT, TEXT, UUID, UUID, BIGINT);
DROP TABLE IF EXISTS crm_inbound_events;

DELETE FROM crm_events WHERE event_type IN ('ownership.taken', 'ownership.released');

ALTER TABLE crm_events
  DROP CONSTRAINT IF EXISTS crm_events_ownership_change_key,
  DROP CONSTRAINT IF EXISTS crm_events_event_type_check,
  DROP CONSTRAINT IF EXISTS crm_events_identity_check,
  DROP COLUMN IF EXISTS ownership_change_id;

-- Restore the 039 identity check and trigger function.
ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
  (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
  AND (event_type <> 'message.new' OR message_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION crm_events_body_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id
     OR NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, event_type, revision, lead_id and message_id never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_track_ownership_acquired ON lead_chat_ownerships;
DROP TRIGGER IF EXISTS trg_crm_track_ownership_released ON lead_chat_ownerships;
DROP FUNCTION IF EXISTS crm_track_lead_chat_ownership();
DROP TABLE IF EXISTS crm_ownership_changes;
DROP TABLE IF EXISTS crm_conversation_ownership;
DROP FUNCTION IF EXISTS crm_lead_conversation_id(BIGINT);

DELETE FROM lead_chat_ownerships WHERE clickup_task_id IS NULL;

ALTER TABLE lead_chat_ownerships
  DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_acquired_via,
  DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_released_via,
  DROP COLUMN IF EXISTS owner_seller_id,
  DROP COLUMN IF EXISTS released_via,
  DROP COLUMN IF EXISTS acquired_via;

ALTER TABLE lead_chat_ownerships ALTER COLUMN clickup_task_id SET NOT NULL;
