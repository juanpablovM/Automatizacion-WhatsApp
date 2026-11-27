-- CRM 1.3: outbox schema for contact events and the delivery epoch.
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (U2, S2, S9).
--
-- 1. crm_events.contact_id (nullable, RESTRICT): the customer an event belongs
--    to. contact.upserted / contact.state require it and carry no
--    conversation_id; every 1.1/1.2 type keeps requiring conversation_id
--    exactly as before (the column NOT NULL moves into the identity check).
--    A 1.3 event of an existing type may also carry contact_id.
-- 2. crm_events.id_prefix: the delivery epoch, i.e. the CRM_EVENTS_ID_PREFIX
--    embedded in event_id (`wa-<prefix>-...`). It is derived from event_id
--    (crm_event_id_prefix(); '' for an id outside that shape) by a BEFORE
--    INSERT trigger, so no existing insert changes, and a CHECK keeps it equal
--    to that derivation. Every per-entity unique now includes it: one prefix
--    still never enqueues an entity twice, while a new prefix (the CRM
--    production switch) can enqueue the same history again.
--    The unique constraints/indexes keep their names, so existing error
--    matching is unchanged.
-- 3. (contact_id, event_type, revision, id_prefix) is unique for contact.*.
-- 4. The immutability trigger also covers contact_id and id_prefix.
--
-- The dispatcher is unchanged: every insert uses ON CONFLICT DO NOTHING with
-- no conflict target, and its "already enqueued?" reads are not filtered by
-- prefix yet (later 1.3 units add that). Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
ALTER TABLE crm_events
  ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES crm_contacts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS id_prefix TEXT;

ALTER TABLE crm_events ALTER COLUMN conversation_id DROP NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Delivery epoch
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_event_id_prefix(p_event_id TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(substring(p_event_id FROM '^wa-([a-z0-9]{1,16})-'), '')
$$;

-- Backfill before the immutability trigger covers id_prefix.
UPDATE crm_events
SET id_prefix = crm_event_id_prefix(event_id)
WHERE id_prefix IS NULL;

CREATE OR REPLACE FUNCTION crm_events_set_id_prefix()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id_prefix IS NULL THEN
    NEW.id_prefix := crm_event_id_prefix(NEW.event_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_events_set_id_prefix ON crm_events;
CREATE TRIGGER trg_crm_events_set_id_prefix
BEFORE INSERT ON crm_events
FOR EACH ROW EXECUTE FUNCTION crm_events_set_id_prefix();

ALTER TABLE crm_events ALTER COLUMN id_prefix SET NOT NULL;

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_id_prefix_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_id_prefix_check CHECK (
  id_prefix = crm_event_id_prefix(event_id)
);

-- -----------------------------------------------------------------------------
-- 3. Types and identity
-- -----------------------------------------------------------------------------
ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_event_type_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_event_type_check CHECK (
  event_type IN ('lead.qualified', 'message.new', 'ownership.taken', 'ownership.released', 'handoff.created',
                 'contact.upserted', 'contact.state')
);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_identity_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
  (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
  AND (event_type <> 'message.new' OR message_id IS NOT NULL)
  AND (event_type NOT IN ('ownership.taken', 'ownership.released') OR ownership_change_id IS NOT NULL)
  AND (event_type <> 'handoff.created' OR handoff_id IS NOT NULL)
  AND (event_type NOT IN ('contact.upserted', 'contact.state') OR (contact_id IS NOT NULL AND conversation_id IS NULL))
  AND (event_type IN ('contact.upserted', 'contact.state') OR conversation_id IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- 2b. Per-entity uniques include the delivery epoch (same names)
-- -----------------------------------------------------------------------------
ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_lead_type_revision_key;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_lead_type_revision_key
  UNIQUE (lead_id, event_type, revision, id_prefix);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_message_type_key;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_message_type_key
  UNIQUE (message_id, event_type, id_prefix);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_ownership_change_key;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_ownership_change_key
  UNIQUE (ownership_change_id, id_prefix);

DROP INDEX IF EXISTS crm_events_handoff_revision_key;
CREATE UNIQUE INDEX crm_events_handoff_revision_key
  ON crm_events (handoff_id, revision, id_prefix)
  WHERE handoff_id IS NOT NULL;

DROP INDEX IF EXISTS crm_events_contact_type_revision_key;
CREATE UNIQUE INDEX crm_events_contact_type_revision_key
  ON crm_events (contact_id, event_type, revision, id_prefix)
  WHERE event_type IN ('contact.upserted', 'contact.state');

-- -----------------------------------------------------------------------------
-- 4. Immutability
-- -----------------------------------------------------------------------------
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
     OR NEW.ownership_change_id IS DISTINCT FROM OLD.ownership_change_id
     OR NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.id_prefix IS DISTINCT FROM OLD.id_prefix THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, event_type, revision, lead_id, message_id, ownership_change_id, handoff_id, contact_id and id_prefix never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
