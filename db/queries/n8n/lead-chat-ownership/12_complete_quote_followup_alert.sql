-- =============================================================================
-- 12_complete_quote_followup_alert.sql — Close one quote follow-up alert claim.
-- -----------------------------------------------------------------------------
-- Migration 037. CAS on the claim token from 11_claim_quote_followup_alerts.sql:
-- a worker whose claim was reclaimed gets 'claim_mismatch' and writes nothing.
-- Every result closes the streak — 'sent', 'failed', 'cancelled' (the seller
-- was answering at that moment) and 'unknown' alike — because quote_alerted_at
-- moves the streak anchor: a failed notice is visible here and in audit_logs,
-- never retried every minute at the customer. Only a 'sent' notice leaves the
-- new-quote offer pending (01_load_active_context.sql).
--
-- The ownership is never released and the ClickUp status is never written.
--
-- Always returns exactly one row.
--
-- Params:
--   p1 ownership_id, p2 claim_token, p3 result (sent|failed|cancelled|unknown),
--   p4 error (nullable), p5 comment_outcome (text, audit only)
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '')::bigint AS ownership_id,
    NULLIF($2::text, '') AS claim_token,
    CASE
      WHEN NULLIF($3::text, '') IN ('sent', 'failed', 'cancelled', 'unknown') THEN $3::text
      ELSE 'unknown'
    END AS result,
    NULLIF($4::text, '') AS error,
    NULLIF($5::text, '') AS comment_outcome
),
completed AS (
  UPDATE lead_chat_ownerships o
  SET
    quote_alert_state = 'completed',
    quote_alert_claim_token = NULL,
    quote_alerted_at = NOW(),
    quote_alert_result = i.result,
    quote_alert_error = i.error,
    updated_at = NOW()
  FROM input i
  WHERE o.id = i.ownership_id
    AND i.claim_token IS NOT NULL
    AND o.quote_alert_claim_token = i.claim_token
    AND o.quote_alert_state = 'processing'
  RETURNING o.id, o.lead_id, o.quote_alert_message_id, o.quote_alert_result
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_quote_followup_alert',
    'lead_chat_ownership',
    c.id,
    'system',
    'ops-lead-chat-lease-scheduler',
    'alert_' || c.quote_alert_result,
    jsonb_build_object('quote_alert_state', 'processing'),
    jsonb_build_object('quote_alert_state', 'completed', 'quote_alert_result', c.quote_alert_result),
    jsonb_build_object(
      'lead_id', c.lead_id,
      'quote_alert_message_id', c.quote_alert_message_id,
      'error', i.error,
      'comment_outcome', i.comment_outcome
    )
  FROM completed c
  CROSS JOIN input i
  RETURNING 1
)
SELECT
  c.id AS ownership_id,
  c.quote_alert_result,
  'completed' AS outcome
FROM completed c

UNION ALL

SELECT
  i.ownership_id,
  NULL::text,
  CASE WHEN i.ownership_id IS NULL THEN 'unknown_ownership' ELSE 'claim_mismatch' END
FROM input i
WHERE NOT EXISTS (SELECT 1 FROM completed);
