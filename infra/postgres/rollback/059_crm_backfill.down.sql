-- Rollback of migration 059 (CRM 1.3 backfill).
--
-- Order: 1. re-import the pre-059 crm-events-dispatcher workflow (its 01, 05,
-- 07, 09, 11 and 13 call crm_contact_backfill_pending, and 15/16 use the
-- tables below); 2. if a backfill run exists and the previous prefix comes
-- back, restore its archived CRM ids first:
--   SELECT * FROM crm_backfill_abandon('<prefix>');
-- 3. apply this file. crm_events rows the backfill enqueued stay (immutable
-- history); crm_contacts.ownership_version keeps any holder version it
-- reached (a counter only grows).
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS crm_backfill_abandon(TEXT);
DROP FUNCTION IF EXISTS crm_backfill_start(TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS crm_lead_last_activity_at(BIGINT);
DROP FUNCTION IF EXISTS crm_backfill_lead_outcome(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS crm_contact_backfill_pending(BIGINT, TEXT);

DROP TABLE IF EXISTS crm_backfill_blocks;
DROP TABLE IF EXISTS crm_contact_backfills;
DROP TABLE IF EXISTS crm_backfill_runs;

COMMIT;
