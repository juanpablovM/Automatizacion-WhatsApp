-- Rollback of migration 039 (CRM message.new and 1.2 record corrections).
-- Set CRM_EVENTS_PROTOCOL_REVISION=1.1 (or deactivate crm-events-dispatcher)
-- first: the 1.2 stages read and write these objects.
-- Destructive: message.new rows are deleted, because lead_id becomes NOT NULL
-- again and the 038 schema cannot hold them.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

DROP FUNCTION IF EXISTS crm_lead_source_hash(BIGINT);

ALTER TABLE leads
  DROP COLUMN IF EXISTS crm_checked_source_hash,
  DROP COLUMN IF EXISTS crm_enqueued_record_hash;

DROP TABLE IF EXISTS crm_message_blocks;

DROP INDEX IF EXISTS idx_crm_events_lead_conversation;

DELETE FROM crm_events WHERE lead_id IS NULL;

ALTER TABLE crm_events
  DROP CONSTRAINT IF EXISTS crm_events_message_type_key,
  DROP CONSTRAINT IF EXISTS crm_events_identity_check,
  DROP COLUMN IF EXISTS message_id,
  ALTER COLUMN lead_id SET NOT NULL;

-- Restore the 038 trigger function.
CREATE OR REPLACE FUNCTION crm_events_body_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, revision and lead_id never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;
