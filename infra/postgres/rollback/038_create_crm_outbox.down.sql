-- Rollback of migration 038 (CRM outbox). Deactivate or delete the
-- crm-events-dispatcher workflow first: it reads and writes these objects.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

DROP INDEX IF EXISTS idx_leads_crm_blocked_reason;

ALTER TABLE leads
  DROP COLUMN IF EXISTS crm_blocked_reason,
  DROP COLUMN IF EXISTS crm_enqueued_requirement,
  DROP COLUMN IF EXISTS crm_revision,
  DROP COLUMN IF EXISTS crm_opportunity_id,
  DROP COLUMN IF EXISTS crm_customer_id;

DROP INDEX IF EXISTS uq_sellers_crm_user_id;

ALTER TABLE sellers
  DROP COLUMN IF EXISTS crm_user_id;

DROP TABLE IF EXISTS crm_events;

DROP FUNCTION IF EXISTS crm_events_body_immutable();
