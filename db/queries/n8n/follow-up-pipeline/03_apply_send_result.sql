-- Complete one claimed send and atomically create the next cadence step.
-- $1 follow_up_id, $2 claim_token, $3 outcome(sent|failed|unknown),
-- $4 error, $5 outbound_delivery_status, $6 outbound_message_id
WITH target AS (
  SELECT f.* FROM follow_ups f
  WHERE f.id = $1::bigint AND f.deleted_at IS NULL
  FOR UPDATE
), authorized AS (
  SELECT * FROM target
  WHERE estado = 'sending' AND claim_token::text = NULLIF($2::text, '')
), resolved AS (
  SELECT a.*,
    CASE
      WHEN $3::text = 'sent' THEN 'sent'
      WHEN $3::text = 'unknown' THEN 'unknown'
      WHEN a.send_attempt_count + 1 >= a.max_send_attempts THEN 'send_exhausted'
      ELSE 'retry'
    END resolution
  FROM authorized a
), applied AS (
  UPDATE follow_ups f SET
    estado = CASE WHEN r.resolution = 'sent' THEN 'sent' ELSE 'error' END,
    result = CASE WHEN r.resolution = 'sent' THEN COALESCE(f.result, 'no_response') ELSE f.result END,
    sent_at = CASE WHEN r.resolution = 'sent' THEN COALESCE(f.sent_at, NOW()) ELSE f.sent_at END,
    send_attempt_count = f.send_attempt_count + 1,
    next_retry_at = CASE WHEN r.resolution = 'retry'
      THEN NOW() + LEAST(3600, 30 * (2 ^ f.send_attempt_count)) * INTERVAL '1 second'
      ELSE NULL END,
    last_send_error = CASE WHEN r.resolution = 'sent' THEN NULL ELSE COALESCE(NULLIF($4::text, ''), r.resolution) END,
    claim_token = NULL, claimed_at = NULL,
    delivery_log = f.delivery_log || jsonb_build_object(
      'at', NOW(), 'status', r.resolution,
      'outbound_delivery_status', NULLIF($5::text, ''),
      'outbound_message_id', NULLIF($6::text, ''),
      'error', NULLIF($4::text, '')
    ), updated_at = NOW()
  FROM resolved r WHERE f.id = r.id
  RETURNING f.*, r.resolution
), next_values AS (
  SELECT a.*,
    CASE a.step_dia WHEN 0 THEN 1 WHEN 1 THEN 3 WHEN 3 THEN 7 WHEN 7 THEN 14 END::smallint next_step
  FROM applied a WHERE a.resolution = 'sent'
), next_insert AS (
  INSERT INTO follow_ups (
    idempotency_key, cycle_key, conversation_id, opportunity_id, phone_number,
    source_number_id, motivo, step_dia, scheduled_at, metadata
  )
  SELECT n.conversation_id || ':' || n.cycle_key || ':' || n.next_step,
    n.cycle_key, n.conversation_id, n.opportunity_id, n.phone_number,
    n.source_number_id, n.motivo, n.next_step,
    n.scheduled_at + (n.next_step - n.step_dia) * INTERVAL '1 day',
    jsonb_build_object('cycle_key', n.cycle_key, 'previous_follow_up_id', n.id)
  FROM next_values n
  WHERE n.next_step IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM follow_up_preferences p
                    WHERE p.conversation_id = n.conversation_id AND p.opted_out = TRUE)
  ON CONFLICT (conversation_id, cycle_key, step_dia) WHERE deleted_at IS NULL DO NOTHING
  RETURNING id
), audit_entry AS (
  INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata)
  SELECT 'follow_up_send', 'follow_up', a.id, 'system', 'ops-follow-up-scheduler',
    a.resolution, '{}'::jsonb,
    jsonb_build_object('estado', a.estado, 'attempts', a.send_attempt_count),
    jsonb_build_object('outcome', $3::text, 'next_scheduled', EXISTS(SELECT 1 FROM next_insert))
  FROM applied a RETURNING id
)
SELECT a.id follow_up_id, a.estado follow_up_estado, a.send_attempt_count,
  a.resolution result, (SELECT id FROM next_insert LIMIT 1) next_follow_up_id
FROM applied a
UNION ALL
SELECT t.id, t.estado, t.send_attempt_count, 'claim_rejected', NULL::bigint
FROM target t WHERE NOT EXISTS (SELECT 1 FROM authorized);
