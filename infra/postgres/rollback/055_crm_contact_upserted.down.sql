-- Rollback of migration 055: drops crm_contacts.crm_blocked_reason (only a
-- diagnostic of the contact.upserted stage; no event or contact is lost).
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE crm_contacts DROP COLUMN IF EXISTS crm_blocked_reason;

COMMIT;
