-- CRM 1.3: contact.upserted stage bookkeeping.
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (U3, S3).
--
-- crm_contacts.crm_blocked_reason: why the last contact.upserted build of the
-- contact was rejected (for example an invalid phone). Select Contact
-- Candidates puts blocked contacts last so they cannot starve the batch;
-- Insert Contact Events sets it and clears it once an event is enqueued.
-- The last enqueued revision and the phone/name it carried are read from
-- crm_events (per id prefix), so no revision or hash is stored here: a new
-- CRM_EVENTS_ID_PREFIX starts every contact again at revision 1.
--
-- Additive: no existing row or behaviour changes. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS crm_blocked_reason TEXT;

COMMIT;
