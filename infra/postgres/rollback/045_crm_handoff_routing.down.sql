-- Rollback of migration 045 (CRM handoff routing). Drops the routing function
-- and handoffs.crm_blocked_reason. Routing already stored on handoffs (044
-- columns) stays. Restore the pre-045 crm-events-dispatcher workflow first,
-- or set CRM_EVENTS_HANDOFFS_ENABLED=false.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS crm_route_handoff(BIGINT, BIGINT);
ALTER TABLE handoffs DROP COLUMN IF EXISTS crm_blocked_reason;

COMMIT;
