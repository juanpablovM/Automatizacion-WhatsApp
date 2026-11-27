-- CRM 1.3: contact.state stage bookkeeping.
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (U5, S4).
--
-- contact.state is a polled snapshot: the state of a customer changes through
-- many writers (conversation status, handoffs, seller leases that expire by
-- time), so Select Contact State Candidates recomputes it every pass and only
-- returns the contacts whose inputs changed since their last check.
--
-- crm_contact_state_marks keeps, per contact and delivery epoch (id prefix):
--   input_hash      md5 of what the state, progress and stage were built from
--                   (state, latest conversation, its pending question and
--                   qualification context, the catalog variants) at the last
--                   check that settled. NULL means "check again next pass".
--   blocked_reason  why the last build was rejected; such contacts go last.
--   checked_at      when the mark was last written (diagnostic).
-- state_version is not stored here: it is the newest contact.state revision
-- in crm_events under the same id prefix (as U3 does for contact.upserted),
-- so a new CRM_EVENTS_ID_PREFIX starts every contact again at version 1.
--
-- Additive: no existing row or behaviour changes. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS crm_contact_state_marks (
  contact_id BIGINT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  id_prefix TEXT NOT NULL,
  input_hash TEXT,
  blocked_reason TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, id_prefix)
);

COMMIT;
