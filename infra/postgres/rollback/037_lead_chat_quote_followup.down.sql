-- Rollback of migration 037 (quote follow-up chat ownership). Import the
-- pre-037 workflows first: the 037 workflows read and write these columns.
-- Live quote follow-up ownerships fall back to the standard mode, which has no
-- deadline until the next customer message; ownerships released by
-- 'customer_new_quote' are relabeled 'manual' so the original constraint holds.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

DROP INDEX IF EXISTS idx_lead_chat_ownerships_quote_followup;

UPDATE lead_chat_ownerships
SET release_reason = 'manual'
WHERE release_reason = 'customer_new_quote';

ALTER TABLE lead_chat_ownerships DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_release_reason;
ALTER TABLE lead_chat_ownerships
  ADD CONSTRAINT chk_lead_chat_ownerships_release_reason
  CHECK (release_reason IN ('clickup_released', 'sla_expired', 'manual'));

ALTER TABLE lead_chat_ownerships
  DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_quote_alert_result,
  DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_quote_alert_state,
  DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_sla_mode,
  DROP COLUMN IF EXISTS quote_alert_error,
  DROP COLUMN IF EXISTS quote_alert_result,
  DROP COLUMN IF EXISTS quote_alerted_at,
  DROP COLUMN IF EXISTS quote_alert_attempt_count,
  DROP COLUMN IF EXISTS quote_alert_message_id,
  DROP COLUMN IF EXISTS quote_alert_claimed_at,
  DROP COLUMN IF EXISTS quote_alert_claim_token,
  DROP COLUMN IF EXISTS quote_alert_state,
  DROP COLUMN IF EXISTS quote_followup_since,
  DROP COLUMN IF EXISTS sla_mode;
