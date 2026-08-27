-- Apply one persisted inbound to the follow-up policy atomically.
-- $1 target_conversation_id, $2 action, $3 cancel_reason, $4 source_text,
-- $5 source_message_id, $6 should_schedule, $7 phone_number,
-- $8 source_number_id, $9 cycle_key, $10 motivo, $11 scheduled_at,
-- $12 idempotency_key (`follow-up-policy:{conversation}:{inbound identity}`),
-- $13 inbound_event_id, $14 first_delay_hours.
WITH raw_input AS (
  SELECT
    $1::bigint conversation_id,
    NULLIF($2::text, '') action,
    NULLIF($3::text, '') cancel_reason,
    NULLIF($4::text, '') source_text,
    NULLIF($5::text, '')::bigint source_message_id,
    COALESCE(NULLIF($6::text, '')::boolean, FALSE) should_schedule,
    NULLIF($7::text, '') phone_number,
    NULLIF($8::text, '')::bigint source_number_id,
    NULLIF($9::text, '') cycle_key,
    COALESCE(NULLIF($10::text, ''), 'lead_sin_respuesta') motivo,
    NULLIF($11::text, '')::timestamptz requested_scheduled_at,
    NULLIF($12::text, '') idempotency_key,
    NULLIF($13::text, '')::bigint inbound_event_id,
    GREATEST(1, COALESCE(NULLIF($14::text, '')::integer, 24)) first_delay_hours
), input AS (
  SELECT
    r.conversation_id,
    r.action,
    r.cancel_reason,
    r.source_text,
    r.source_message_id,
    r.should_schedule,
    r.phone_number,
    r.source_number_id,
    r.cycle_key,
    r.motivo,
    COALESCE(
      r.requested_scheduled_at,
      ie.created_at + make_interval(hours => r.first_delay_hours)
    ) scheduled_at,
    r.idempotency_key,
    r.inbound_event_id
  FROM raw_input r
  LEFT JOIN inbound_events ie ON ie.id = r.inbound_event_id
), policy_claim AS MATERIALIZED (
  UPDATE inbound_events ie
  SET downstream_payload = jsonb_set(
        COALESCE(ie.downstream_payload, '{}'::jsonb),
        '{follow_up_policy_receipt}',
        jsonb_build_object(
          'idempotency_key', i.idempotency_key,
          'conversation_id', i.conversation_id,
          'claimed_at', NOW()
        ),
        TRUE
      ),
      updated_at = NOW()
  FROM input i
  WHERE ie.id = i.inbound_event_id
    AND i.idempotency_key IS NOT NULL
    AND NOT (COALESCE(ie.downstream_payload, '{}'::jsonb) ? 'follow_up_policy_receipt')
  RETURNING ie.id
), preference AS (
  INSERT INTO follow_up_preferences (
    conversation_id, opted_out, opted_out_at, source_message_id, source_text
  )
  SELECT i.conversation_id, TRUE, NOW(), i.source_message_id, i.source_text
  FROM input i
  WHERE i.action = 'opt_out'
    AND i.idempotency_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM policy_claim)
  ON CONFLICT (conversation_id) DO UPDATE SET
    opted_out = TRUE,
    opted_out_at = COALESCE(follow_up_preferences.opted_out_at, EXCLUDED.opted_out_at),
    source_message_id = EXCLUDED.source_message_id,
    source_text = EXCLUDED.source_text,
    updated_at = NOW()
  RETURNING conversation_id
), cancelled AS (
  UPDATE follow_ups f SET
    estado = CASE WHEN i.action = 'opt_out' THEN 'opted_out' ELSE 'cancelled' END,
    opted_out = (i.action = 'opt_out'),
    result = CASE WHEN i.cancel_reason = 'lost' THEN 'lost' ELSE COALESCE(f.result, 'responded') END,
    lost_reason = CASE WHEN i.cancel_reason = 'lost' THEN i.source_text ELSE f.lost_reason END,
    claim_token = NULL,
    claimed_at = NULL,
    next_retry_at = NULL,
    updated_at = NOW()
  FROM input i
  WHERE f.conversation_id = i.conversation_id
    AND f.deleted_at IS NULL
    AND f.estado IN ('pending', 'sending', 'error')
    AND i.action IN ('opt_out', 'cancel')
    AND i.idempotency_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM policy_claim)
  RETURNING f.id
), scheduled AS (
  INSERT INTO follow_ups (
    idempotency_key, cycle_key, conversation_id, phone_number, source_number_id,
    motivo, step_dia, scheduled_at, metadata
  )
  SELECT
    i.conversation_id || ':' || i.cycle_key || ':1',
    i.cycle_key,
    i.conversation_id,
    i.phone_number,
    i.source_number_id,
    i.motivo,
    1,
    i.scheduled_at,
    jsonb_build_object(
      'cycle_key', i.cycle_key,
      'source_message_id', i.source_message_id,
      'policy_idempotency_key', i.idempotency_key
    )
  FROM input i
  WHERE i.should_schedule
    AND i.cycle_key IS NOT NULL
    AND i.phone_number IS NOT NULL
    AND i.scheduled_at IS NOT NULL
    AND i.idempotency_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM policy_claim)
    AND NOT EXISTS (
      SELECT 1
      FROM follow_up_preferences p
      WHERE p.conversation_id = i.conversation_id
        AND p.opted_out = TRUE
    )
  ON CONFLICT (conversation_id, cycle_key, step_dia) WHERE deleted_at IS NULL DO NOTHING
  RETURNING id
), audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'follow_up_inbound_policy',
    'conversation',
    i.conversation_id,
    'system',
    'wa-inbound-downstream-dispatcher',
    CASE
      WHEN i.action = 'opt_out' THEN 'opted_out'
      WHEN EXISTS(SELECT 1 FROM scheduled) THEN 'cancelled_and_scheduled'
      WHEN i.action = 'cancel' THEN 'cancelled'
      ELSE 'no_action'
    END,
    '{}'::jsonb,
    jsonb_build_object(
      'cancelled', (SELECT COUNT(*) FROM cancelled),
      'scheduled', (SELECT COUNT(*) FROM scheduled),
      'action', i.action,
      'idempotency_key', i.idempotency_key
    ),
    jsonb_build_object('cycle_key', i.cycle_key)
  FROM input i
  WHERE i.idempotency_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM policy_claim)
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM cancelled) cancelled_count,
  (SELECT COUNT(*) FROM scheduled) scheduled_count,
  EXISTS(SELECT 1 FROM preference) opted_out_persisted,
  (
    EXISTS(SELECT 1 FROM input WHERE idempotency_key IS NOT NULL AND inbound_event_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM policy_claim)
  ) replayed,
  CASE
    WHEN EXISTS(SELECT 1 FROM input WHERE idempotency_key IS NOT NULL AND inbound_event_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM policy_claim) THEN 'replayed'
    WHEN EXISTS(SELECT 1 FROM preference) THEN 'opted_out'
    WHEN EXISTS(SELECT 1 FROM scheduled) THEN 'scheduled'
    WHEN EXISTS(SELECT 1 FROM cancelled) THEN 'cancelled'
    ELSE 'no_action'
  END result;
