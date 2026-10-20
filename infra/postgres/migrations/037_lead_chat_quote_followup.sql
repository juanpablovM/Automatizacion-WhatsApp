-- Quote follow-up chat ownership (owner decision 2026-10-16).
--
-- While a seller owns the chat the bot stays silent. In 'en atención' that
-- ownership has a 2-hour SLA: when it expires the bot resumes and the ClickUp
-- task goes back to its previous status. Once the quote was sent ('cotización
-- enviada' or 'seguimiento', CLICKUP_STATUS_QUOTE_SENT_FOLLOWUP) that is wrong:
-- the quote is the seller's, and moving the task back to 'nueva' undoes the
-- seller's work. In that mode:
--   * the ownership has no expiry (response_due_at stays NULL), so the lease
--     sweep never releases it and the task status is never restored;
--   * when the customer writes and the seller does not answer within
--     LEAD_CHAT_QUOTE_SENT_SLA_MINUTES, the lease scheduler sends one notice to
--     the customer and one ClickUp comment to the assigned seller (the
--     quote_alert_* columns are that claim and its result);
--   * the notice asks whether the customer wants a new quote. A yes releases
--     the ownership with release_reason 'customer_new_quote' and starts a new
--     conversation; the old task is left untouched.
--
-- sla_mode is the ownership's current mode, written by the ClickUp status
-- webhook (01_acquire_ownership_from_clickup.sql). quote_followup_since is when
-- the ownership entered that mode: customer messages older than it were the
-- seller's to handle before the quote and never start an alert.
-- Additive: every new column is nullable or defaulted, and 'standard' keeps the
-- pre-037 behavior for every existing row.

ALTER TABLE lead_chat_ownerships
  ADD COLUMN IF NOT EXISTS sla_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS quote_followup_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_alert_state TEXT,
  ADD COLUMN IF NOT EXISTS quote_alert_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS quote_alert_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_alert_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quote_alert_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_alerted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_alert_result TEXT,
  ADD COLUMN IF NOT EXISTS quote_alert_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lead_chat_ownerships_sla_mode') THEN
    ALTER TABLE lead_chat_ownerships
      ADD CONSTRAINT chk_lead_chat_ownerships_sla_mode
      CHECK (sla_mode IN ('standard', 'quote_followup'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lead_chat_ownerships_quote_alert_state') THEN
    ALTER TABLE lead_chat_ownerships
      ADD CONSTRAINT chk_lead_chat_ownerships_quote_alert_state
      CHECK (quote_alert_state IS NULL OR quote_alert_state IN ('processing', 'completed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lead_chat_ownerships_quote_alert_result') THEN
    ALTER TABLE lead_chat_ownerships
      ADD CONSTRAINT chk_lead_chat_ownerships_quote_alert_result
      CHECK (quote_alert_result IS NULL OR quote_alert_result IN ('sent', 'failed', 'cancelled', 'unknown'));
  END IF;
END
$$;

-- A customer who accepts the new-quote offer ends the seller's ownership.
ALTER TABLE lead_chat_ownerships DROP CONSTRAINT IF EXISTS chk_lead_chat_ownerships_release_reason;
ALTER TABLE lead_chat_ownerships
  ADD CONSTRAINT chk_lead_chat_ownerships_release_reason
  CHECK (release_reason IN ('clickup_released', 'sla_expired', 'manual', 'customer_new_quote'));

-- The quote follow-up sweep only looks at live ownerships in that mode.
CREATE INDEX IF NOT EXISTS idx_lead_chat_ownerships_quote_followup
ON lead_chat_ownerships (quote_followup_since)
WHERE released_at IS NULL AND deleted_at IS NULL AND sla_mode = 'quote_followup';
