-- Rollback of migration 035 (lead ClickUp task tracking). Import the pre-035
-- workflows first: the 035 workflows read and write these columns.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

ALTER TABLE leads
  DROP COLUMN IF EXISTS clickup_synced_requirement,
  DROP COLUMN IF EXISTS clickup_status_at,
  DROP COLUMN IF EXISTS clickup_status;
