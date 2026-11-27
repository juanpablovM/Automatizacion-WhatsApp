-- Rollback of migration 057: drops crm_contact_state_marks (only the change
-- detection of the contact.state stage; no event or contact is lost). The next
-- pass after re-applying 057 checks every contact once and enqueues nothing
-- for a contact whose state did not change.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS crm_contact_state_marks;

COMMIT;
