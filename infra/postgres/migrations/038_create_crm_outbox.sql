-- CRM outbox: bot -> CRM events (contract v1, revision 1.1).
--
-- The new CRM replaces ClickUp as the seller platform. The bot announces each
-- qualified lead with a signed `lead.qualified` event. Delivery is an outbox:
--   * crm_events holds one row per event with the EXACT body bytes sent. A
--     retry must send a byte-identical body under the same event_id (changed
--     bytes return 409), so `body` is written once and never re-serialized.
--   * status: pending -> processing (claimed with claim_token) -> delivered,
--     back to pending with next_attempt_at on a retryable failure, or parked
--     on a rejection a human has to reconcile.
--   * (lead_id, event_type, revision) is unique: a requirement correction is a
--     new row with the next revision, never an edit of the old one.
-- sellers.crm_user_id maps a seller to the CRM `usuarios.id`; a seller without
-- it blocks the lead (leads.crm_blocked_reason) until it is mapped.
-- Additive and nullable: the ClickUp path ignores every column added here.

CREATE TABLE IF NOT EXISTS crm_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  lead_id BIGINT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token UUID,
  locked_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_event_id_key') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_event_id_key UNIQUE (event_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_lead_type_revision_key') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_lead_type_revision_key UNIQUE (lead_id, event_type, revision);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_status_check') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_status_check
      CHECK (status IN ('pending', 'processing', 'delivered', 'parked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_revision_check') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_revision_check CHECK (revision >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_body_size_check') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_body_size_check
      CHECK (octet_length(body) BETWEEN 2 AND 65536);
  END IF;
END
$$;

-- The claim scans pending rows by due time and stale processing rows by lock age.
CREATE INDEX IF NOT EXISTS idx_crm_events_claim
ON crm_events (next_attempt_at, id)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_crm_events_processing
ON crm_events (locked_at)
WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_crm_events_parked
ON crm_events (updated_at)
WHERE status = 'parked';

-- The body is immutable: a retry must resend the exact bytes.
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

DROP TRIGGER IF EXISTS trg_crm_events_body_immutable ON crm_events;
CREATE TRIGGER trg_crm_events_body_immutable
BEFORE UPDATE ON crm_events
FOR EACH ROW EXECUTE FUNCTION crm_events_body_immutable();

ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS crm_user_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sellers_crm_user_id
ON sellers (crm_user_id)
WHERE crm_user_id IS NOT NULL AND deleted_at IS NULL;

-- crm_customer_id / crm_opportunity_id / crm_revision: what the CRM returned for
-- the newest delivered revision. crm_enqueued_requirement: the requirement the
-- newest enqueued event carried; a lead whose requirement differs is new or
-- corrected and gets the next revision. crm_blocked_reason: why the lead is not
-- enqueued yet (e.g. seller_not_mapped); cleared when it is enqueued.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS crm_customer_id UUID,
  ADD COLUMN IF NOT EXISTS crm_opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS crm_revision INTEGER,
  ADD COLUMN IF NOT EXISTS crm_enqueued_requirement TEXT,
  ADD COLUMN IF NOT EXISTS crm_blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_crm_blocked_reason
ON leads (crm_blocked_reason)
WHERE crm_blocked_reason IS NOT NULL;
