-- Rollback of migration 054: restores the 044 crm_events schema (no
-- contact_id, no id_prefix, conversation_id NOT NULL, the 1.2 type/identity
-- checks, the per-entity uniques without the delivery epoch and the 044
-- immutability trigger).
--
-- Fails closed, deleting nothing: it refuses while crm_events holds a
-- contact.* event or the same entity enqueued under more than one id prefix,
-- because the 044 schema cannot represent either. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm_events WHERE event_type IN ('contact.upserted', 'contact.state')) THEN
    RAISE EXCEPTION 'rollback 054 refused: crm_events holds contact.* events';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crm_events WHERE lead_id IS NOT NULL
    GROUP BY lead_id, event_type, revision HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM crm_events WHERE message_id IS NOT NULL
    GROUP BY message_id, event_type HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM crm_events WHERE ownership_change_id IS NOT NULL
    GROUP BY ownership_change_id HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM crm_events WHERE handoff_id IS NOT NULL
    GROUP BY handoff_id, revision HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'rollback 054 refused: an entity is enqueued under more than one id prefix';
  END IF;
END
$$;

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
     OR NEW.handoff_id IS DISTINCT FROM OLD.handoff_id THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, event_type, revision, lead_id, message_id, ownership_change_id and handoff_id never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS crm_events_contact_type_revision_key;

DROP INDEX IF EXISTS crm_events_handoff_revision_key;
CREATE UNIQUE INDEX crm_events_handoff_revision_key
  ON crm_events (handoff_id, revision)
  WHERE handoff_id IS NOT NULL;

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_ownership_change_key;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_ownership_change_key UNIQUE (ownership_change_id);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_message_type_key;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_message_type_key UNIQUE (message_id, event_type);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_lead_type_revision_key;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_lead_type_revision_key UNIQUE (lead_id, event_type, revision);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_identity_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
  (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
  AND (event_type <> 'message.new' OR message_id IS NOT NULL)
  AND (event_type NOT IN ('ownership.taken', 'ownership.released') OR ownership_change_id IS NOT NULL)
  AND (event_type <> 'handoff.created' OR handoff_id IS NOT NULL)
);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_event_type_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_event_type_check CHECK (
  event_type IN ('lead.qualified', 'message.new', 'ownership.taken', 'ownership.released', 'handoff.created')
);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_id_prefix_check;
DROP TRIGGER IF EXISTS trg_crm_events_set_id_prefix ON crm_events;
DROP FUNCTION IF EXISTS crm_events_set_id_prefix();

ALTER TABLE crm_events ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE crm_events
  DROP COLUMN IF EXISTS id_prefix,
  DROP COLUMN IF EXISTS contact_id;

DROP FUNCTION IF EXISTS crm_event_id_prefix(TEXT);

COMMIT;
