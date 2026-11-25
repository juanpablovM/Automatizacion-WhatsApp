-- CRM 1.2d: contingency handoffs reach the CRM (handoff.created).
--
-- Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S2-S6).
--
-- 1. crm_events carries handoff.created rows. They are identified by
--    handoff_id (lead_id NULL). revision is the routing attempt: 1 for the
--    first event, +1 for each new event after a 422 invalid_seller (same
--    handoff, next seller in the rotation). (handoff_id, revision) is unique.
-- 2. handoffs records how the bot routed it to the CRM, exactly one key:
--    - crm_opportunity_id: the customer's opportunity (its current seller is
--      notified by the CRM), or
--    - crm_routing_seller_id: the seller the bot chose by rotation when the
--      customer has no opportunity (sent as that seller's crm_user_id).
--    crm_case_id is what the CRM answered for an associated complaint.
--    All three stay NULL until the dispatcher routes the handoff.
--
-- Additive: no existing row changes. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. handoffs: CRM routing
-- -----------------------------------------------------------------------------
ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS crm_opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS crm_routing_seller_id BIGINT REFERENCES sellers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS crm_case_id UUID;

ALTER TABLE handoffs DROP CONSTRAINT IF EXISTS handoffs_crm_routing_key_check;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_crm_routing_key_check CHECK (
  crm_opportunity_id IS NULL OR crm_routing_seller_id IS NULL
);

-- -----------------------------------------------------------------------------
-- 2. crm_events: handoff.created
-- -----------------------------------------------------------------------------
ALTER TABLE crm_events
  ADD COLUMN IF NOT EXISTS handoff_id BIGINT REFERENCES handoffs(id) ON DELETE RESTRICT;

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_event_type_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_event_type_check CHECK (
  event_type IN ('lead.qualified', 'message.new', 'ownership.taken', 'ownership.released', 'handoff.created')
);

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_identity_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
  (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
  AND (event_type <> 'message.new' OR message_id IS NOT NULL)
  AND (event_type NOT IN ('ownership.taken', 'ownership.released') OR ownership_change_id IS NOT NULL)
  AND (event_type <> 'handoff.created' OR handoff_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_events_handoff_revision_key
  ON crm_events (handoff_id, revision)
  WHERE handoff_id IS NOT NULL;

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

COMMIT;
