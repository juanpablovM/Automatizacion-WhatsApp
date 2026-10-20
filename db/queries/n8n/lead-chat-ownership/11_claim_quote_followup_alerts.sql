-- =============================================================================
-- 11_claim_quote_followup_alerts.sql — Quote follow-up alerts (batch claim).
-- -----------------------------------------------------------------------------
-- Migration 037. A seller owns the chat of a quote that was already sent
-- (sla_mode 'quote_followup': 'cotización enviada' / 'seguimiento'). The bot
-- stays silent, but a customer must not wait forever: when the first unanswered
-- customer message is older than p2 minutes, this claim hands the ownership to
-- the lease scheduler, which sends one notice to the customer and one ClickUp
-- comment to the assigned seller. The ownership stays live and the ClickUp
-- task status is never touched.
--
-- Unanswered streak (anti-spam): the customer messages after the anchor
--   GREATEST(quote_followup_since,          -- older ones predate the quote
--            last_human_reply_at,           -- the seller answered those
--            quote_alerted_at + p3 hours)   -- already alerted for those
-- where the last term only counts while the seller has not replied since the
-- alert (GREATEST ignores NULLs). So there is at most one alert per streak: it
-- ends when the seller replies, and a customer who keeps writing after the
-- notice is alerted again only p3 hours after it. Bot messages never end a
-- streak.
--
-- Claim, not send: the row moves to quote_alert_state 'processing' with a new
-- token, and 12_complete_quote_followup_alert.sql closes it by token (CAS). A
-- claim older than p4 seconds is abandoned and reclaimed with a new token; the
-- outbound idempotency key (ownership + streak message) keeps a reclaim from
-- sending the notice twice. FOR UPDATE SKIP LOCKED lets concurrent ticks split
-- the batch. Zero rows is the normal answer.
--
-- Params:
--   p1 batch_size (integer, default 20),
--   p2 sla_minutes (numeric, default 30 — LEAD_CHAT_QUOTE_SENT_SLA_MINUTES),
--   p3 realert_hours (numeric, default 24 — LEAD_CHAT_QUOTE_SENT_REALERT_HOURS),
--   p4 stale_processing_seconds (integer, default 900)
-- =============================================================================
WITH input AS (
  SELECT
    COALESCE(NULLIF($1::text, '')::integer, 20) AS batch_size,
    COALESCE(NULLIF($2::text, '')::numeric, 30) AS sla_minutes,
    COALESCE(NULLIF($3::text, '')::numeric, 24) AS realert_hours,
    COALESCE(NULLIF($4::text, '')::integer, 900) AS stale_processing_seconds
),
owned AS (
  SELECT
    o.id,
    o.lead_id,
    GREATEST(
      o.quote_followup_since,
      o.last_human_reply_at,
      CASE
        WHEN o.last_human_reply_at >= o.quote_alerted_at THEN NULL
        ELSE o.quote_alerted_at + i.realert_hours * INTERVAL '1 hour'
      END
    ) AS anchor_at
  FROM lead_chat_ownerships o
  CROSS JOIN input i
  WHERE o.released_at IS NULL
    AND o.deleted_at IS NULL
    AND o.sla_mode = 'quote_followup'
    AND (
      o.quote_alert_state IS DISTINCT FROM 'processing'
      OR o.quote_alert_claimed_at < NOW() - i.stale_processing_seconds * INTERVAL '1 second'
    )
),
due AS (
  SELECT ow.id, ow.anchor_at, first_message.id AS message_id, first_message.created_at
  FROM owned ow
  CROSS JOIN input i
  CROSS JOIN LATERAL (
    SELECT m.id, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.deleted_at IS NULL
      AND m.direction = 'incoming'
      AND m.sender_type = 'customer'
      AND (m.lead_id = ow.lead_id OR c.lead_id = ow.lead_id)
      AND m.created_at > ow.anchor_at
    ORDER BY m.created_at, m.id
    LIMIT 1
  ) first_message
  WHERE first_message.created_at <= NOW() - i.sla_minutes * INTERVAL '1 minute'
),
candidates AS MATERIALIZED (
  SELECT o.id, d.anchor_at, d.message_id, d.created_at AS first_message_at
  FROM lead_chat_ownerships o
  JOIN due d ON d.id = o.id
  -- Re-checked under the lock: a status webhook may have released it.
  WHERE o.released_at IS NULL
    AND o.sla_mode = 'quote_followup'
  ORDER BY d.created_at, o.id
  LIMIT (SELECT batch_size FROM input)
  FOR UPDATE OF o SKIP LOCKED
),
claimed AS (
  UPDATE lead_chat_ownerships o
  SET
    quote_alert_state = 'processing',
    quote_alert_claim_token = gen_random_uuid()::text,
    quote_alert_claimed_at = NOW(),
    quote_alert_message_id = c.message_id,
    quote_alert_attempt_count = o.quote_alert_attempt_count + 1,
    updated_at = NOW()
  FROM candidates c
  WHERE o.id = c.id
  RETURNING o.id, o.lead_id, o.clickup_task_id, o.quote_alert_claim_token,
            o.quote_alert_message_id, o.quote_alert_attempt_count
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_quote_followup_alert',
    'lead_chat_ownership',
    cl.id,
    'system',
    'ops-lead-chat-lease-scheduler',
    'alert_claimed',
    '{}'::jsonb,
    jsonb_build_object('quote_alert_state', 'processing'),
    jsonb_build_object(
      'lead_id', cl.lead_id,
      'quote_alert_message_id', cl.quote_alert_message_id,
      'quote_alert_attempt_count', cl.quote_alert_attempt_count
    )
  FROM claimed cl
  RETURNING 1
)
SELECT
  cl.id AS ownership_id,
  cl.lead_id,
  cl.quote_alert_claim_token,
  cl.quote_alert_message_id,
  cl.quote_alert_attempt_count,
  COALESCE(NULLIF(l.clickup_task_id, ''), cl.clickup_task_id) AS clickup_task_id,
  l.clickup_status,
  l.whatsapp_name AS lead_name,
  s.name AS seller_name,
  s.clickup_user_id AS seller_clickup_user_id,
  first_conversation.id AS conversation_id,
  first_conversation.phone_number,
  wn.instance_name,
  ca.first_message_at,
  FLOOR(EXTRACT(EPOCH FROM (NOW() - ca.first_message_at)) / 60)::integer AS waiting_minutes,
  COALESCE(streak.customer_messages, ARRAY[]::text[]) AS customer_messages
FROM claimed cl
JOIN candidates ca ON ca.id = cl.id
JOIN messages first_message ON first_message.id = cl.quote_alert_message_id
JOIN conversations first_conversation ON first_conversation.id = first_message.conversation_id
LEFT JOIN whatsapp_numbers wn ON wn.id = first_conversation.source_number_id
LEFT JOIN leads l ON l.id = cl.lead_id
LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT ARRAY_AGG(recent.text_body ORDER BY recent.created_at, recent.id) AS customer_messages
  FROM (
    SELECT m.id, m.created_at, m.text_body
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.deleted_at IS NULL
      AND m.direction = 'incoming'
      AND m.sender_type = 'customer'
      AND (m.lead_id = cl.lead_id OR c.lead_id = cl.lead_id)
      AND m.created_at > ca.anchor_at
      AND NULLIF(BTRIM(m.text_body), '') IS NOT NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 10
  ) recent
) streak ON TRUE
ORDER BY cl.id;
