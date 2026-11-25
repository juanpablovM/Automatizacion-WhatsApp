-- Rollback of migration 044 (handoff.created in the CRM outbox). Deletes the
-- handoff.created outbox rows (their CRM-side effect is not undone), restores
-- the 040 event type, identity check and immutability trigger, and drops the
-- handoff CRM routing columns. Roll back 045 and 046 first.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE crm_events DISABLE TRIGGER USER;
DELETE FROM crm_events WHERE event_type = 'handoff.created';
ALTER TABLE crm_events ENABLE TRIGGER USER;

DROP INDEX IF EXISTS crm_events_handoff_revision_key;

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_identity_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
  (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
  AND (event_type <> 'message.new' OR message_id IS NOT NULL)
  AND (event_type NOT IN ('ownership.taken', 'ownership.released') OR ownership_change_id IS NOT NULL)
);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_event_type_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_event_type_check CHECK (
  event_type IN ('lead.qualified', 'message.new', 'ownership.taken', 'ownership.released')
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
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.ownership_change_id IS DISTINCT FROM OLD.ownership_change_id THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, event_type, revision, lead_id, message_id and ownership_change_id never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE crm_events DROP COLUMN IF EXISTS handoff_id;

ALTER TABLE handoffs DROP CONSTRAINT IF EXISTS handoffs_crm_routing_key_check;
ALTER TABLE handoffs
  DROP COLUMN IF EXISTS crm_case_id,
  DROP COLUMN IF EXISTS crm_routing_seller_id,
  DROP COLUMN IF EXISTS crm_opportunity_id;

COMMIT;
