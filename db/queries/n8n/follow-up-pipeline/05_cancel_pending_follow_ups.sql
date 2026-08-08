-- Apply every inbound turn to the follow-up policy and optionally start a new cycle.
-- $1 conversation_id, $2 action, $3 cancel_reason, $4 source_text,
-- $5 source_message_id, $6 should_schedule, $7 phone_number,
-- $8 source_number_id, $9 cycle_key, $10 motivo, $11 scheduled_at
WITH input AS (
  SELECT $1::bigint conversation_id, NULLIF($2::text, '') action,
    NULLIF($3::text, '') cancel_reason, NULLIF($4::text, '') source_text,
    NULLIF($5::text, '')::bigint source_message_id,
    COALESCE(NULLIF($6::text, '')::boolean, FALSE) should_schedule,
    NULLIF($7::text, '') phone_number, NULLIF($8::text, '')::bigint source_number_id,
    NULLIF($9::text, '') cycle_key, COALESCE(NULLIF($10::text, ''), 'lead_sin_respuesta') motivo,
    COALESCE(NULLIF($11::text, '')::timestamptz, NOW() + INTERVAL '1 day') scheduled_at
), preference AS (
  INSERT INTO follow_up_preferences (
    conversation_id, opted_out, opted_out_at, source_message_id, source_text
  )
  SELECT conversation_id, TRUE, NOW(), source_message_id, source_text
  FROM input WHERE action = 'opt_out'
  ON CONFLICT (conversation_id) DO UPDATE SET opted_out = TRUE,
    opted_out_at = COALESCE(follow_up_preferences.opted_out_at, EXCLUDED.opted_out_at),
    source_message_id = EXCLUDED.source_message_id,
    source_text = EXCLUDED.source_text, updated_at = NOW()
  RETURNING conversation_id
), cancelled AS (
  UPDATE follow_ups f SET
    estado = CASE WHEN i.action = 'opt_out' THEN 'opted_out' ELSE 'cancelled' END,
    opted_out = (i.action = 'opt_out'),
    result = CASE WHEN i.cancel_reason = 'lost' THEN 'lost' ELSE COALESCE(f.result, 'responded') END,
    lost_reason = CASE WHEN i.cancel_reason = 'lost' THEN i.source_text ELSE f.lost_reason END,
    claim_token = NULL, claimed_at = NULL, next_retry_at = NULL, updated_at = NOW()
  FROM input i
  WHERE f.conversation_id = i.conversation_id AND f.deleted_at IS NULL
    AND f.estado IN ('pending', 'sending', 'error')
    AND i.action IN ('opt_out', 'cancel')
  RETURNING f.id
), scheduled AS (
  INSERT INTO follow_ups (
    idempotency_key, cycle_key, conversation_id, phone_number, source_number_id,
    motivo, step_dia, scheduled_at, metadata
  )
  SELECT i.conversation_id || ':' || i.cycle_key || ':1', i.cycle_key,
    i.conversation_id, i.phone_number, i.source_number_id, i.motivo, 1,
    i.scheduled_at, jsonb_build_object('cycle_key', i.cycle_key, 'source_message_id', i.source_message_id)
  FROM input i
  WHERE i.should_schedule AND i.cycle_key IS NOT NULL AND i.phone_number IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM follow_up_preferences p
                    WHERE p.conversation_id = i.conversation_id AND p.opted_out = TRUE)
  ON CONFLICT (conversation_id, cycle_key, step_dia) WHERE deleted_at IS NULL DO NOTHING
  RETURNING id
), audit_entry AS (
  INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata)
  SELECT 'follow_up_inbound_policy', 'conversation', i.conversation_id,
    'system', 'wa-inbound-downstream-dispatcher',
    CASE WHEN i.action = 'opt_out' THEN 'opted_out'
         WHEN EXISTS(SELECT 1 FROM scheduled) THEN 'cancelled_and_scheduled'
         WHEN i.action = 'cancel' THEN 'cancelled' ELSE 'no_action' END,
    '{}'::jsonb,
    jsonb_build_object('cancelled', (SELECT COUNT(*) FROM cancelled),
      'scheduled', (SELECT COUNT(*) FROM scheduled), 'action', i.action), '{}'::jsonb
  FROM input i RETURNING id
)
SELECT (SELECT COUNT(*) FROM cancelled) cancelled_count,
  (SELECT COUNT(*) FROM scheduled) scheduled_count,
  EXISTS(SELECT 1 FROM preference) opted_out_persisted,
  CASE WHEN EXISTS(SELECT 1 FROM preference) THEN 'opted_out'
       WHEN EXISTS(SELECT 1 FROM scheduled) THEN 'scheduled'
       WHEN EXISTS(SELECT 1 FROM cancelled) THEN 'cancelled'
       ELSE 'no_action' END result;
