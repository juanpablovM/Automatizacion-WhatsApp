-- Apply one persisted inbound to the follow-up policy atomically.
-- p1 target_conversation_id, p2 action, p3 cancel_reason, p4 source_text,
-- p5 source_message_id, p6 should_schedule, p7 phone_number,
-- p8 source_number_id, p9 cycle_key, p10 motivo, p11 scheduled_at,
-- p12 idempotency_key (`follow-up-policy:{conversation}:{inbound identity}`),
-- p13 inbound_event_id, p14 first_delay_hours, p15 window_start, p16 window_end.
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
    GREATEST(1, COALESCE(NULLIF($14::text, '')::integer, 24)) first_delay_hours,
    CASE WHEN COALESCE(NULLIF($15::text, ''), '09:00') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      THEN COALESCE(NULLIF($15::text, ''), '09:00')::time END window_start,
    CASE WHEN COALESCE(NULLIF($16::text, ''), '20:00') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      THEN COALESCE(NULLIF($16::text, ''), '20:00')::time END window_end
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
    CASE WHEN r.cancel_reason = 'postponed_until_tomorrow' THEN
      CASE WHEN r.window_start < r.window_end THEN
        -- A calendar day in Chile, not 24 elapsed hours. Preserve the local
        -- clock only inside the configured half-open send window [start,end).
        (((ie.created_at AT TIME ZONE 'America/Santiago')::date + 1)
          + CASE WHEN (ie.created_at AT TIME ZONE 'America/Santiago')::time >= r.window_start
                   AND (ie.created_at AT TIME ZONE 'America/Santiago')::time < r.window_end
                 THEN (ie.created_at AT TIME ZONE 'America/Santiago')::time
                 ELSE r.window_start END) AT TIME ZONE 'America/Santiago'
      END
    ELSE COALESCE(
      r.requested_scheduled_at,
      ie.created_at + make_interval(hours => r.first_delay_hours)
    ) END scheduled_at,
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
    AND NOT follow_up_contact_opted_out(i.conversation_id)
    -- This inbound may be the very message that closed the conversation or
    -- handed it to a seller. Re-read the persisted state instead of trusting
    -- the payload that started this turn.
    AND follow_up_is_eligible(
      i.conversation_id, i.motivo, i.phone_number, i.source_number_id
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
