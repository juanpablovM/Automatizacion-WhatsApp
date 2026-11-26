-- Rollback of migration 053: removes the contact tracking triggers, the
-- helpers and crm_contacts. Roll back 054 first (crm_events.contact_id
-- references this table; the DROP below fails closed while it exists).
-- No conversation, lead or handoff row is touched. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_crm_track_contact ON handoffs;
DROP TRIGGER IF EXISTS trg_crm_track_contact ON leads;
DROP TRIGGER IF EXISTS trg_crm_track_contact ON conversations;
DROP FUNCTION IF EXISTS crm_track_contact();
DROP FUNCTION IF EXISTS crm_contacts_seed();
DROP FUNCTION IF EXISTS crm_contact_ref(BIGINT, TEXT);
DROP TABLE IF EXISTS crm_contacts;

COMMIT;
