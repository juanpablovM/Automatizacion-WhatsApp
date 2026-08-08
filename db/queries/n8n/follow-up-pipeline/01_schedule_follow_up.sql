-- Schedule one cadence step. Positional parameters are required by n8n Postgres v2.
-- $1 conversation_id, $2 opportunity_id, $3 phone_number, $4 source_number_id,
-- $5 motivo, $6 step_dia, $7 scheduled_at, $8 cycle_key
WITH input AS (
  SELECT $1::bigint conversation_id, NULLIF($2::text, '')::bigint opportunity_id,
    $3::text phone_number, NULLIF($4::text, '')::bigint source_number_id,
    $5::text motivo, $6::smallint step_dia, $7::timestamptz scheduled_at,
    NULLIF($8::text, '') cycle_key
), inserted AS (
  INSERT INTO follow_ups (
    idempotency_key, cycle_key, conversation_id, opportunity_id, phone_number,
    source_number_id, motivo, step_dia, scheduled_at, metadata
  )
  SELECT i.conversation_id || ':' || i.cycle_key || ':' || i.step_dia,
    i.cycle_key, i.conversation_id, i.opportunity_id, i.phone_number,
    i.source_number_id, i.motivo, i.step_dia, i.scheduled_at,
    jsonb_build_object('cycle_key', i.cycle_key)
  FROM input i
  WHERE i.cycle_key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM follow_up_preferences p
      WHERE p.conversation_id = i.conversation_id AND p.opted_out = TRUE
    )
  ON CONFLICT (conversation_id, cycle_key, step_dia) WHERE deleted_at IS NULL DO NOTHING
  RETURNING id
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM inserted) THEN 'scheduled'
  WHEN EXISTS (SELECT 1 FROM follow_up_preferences p, input i
               WHERE p.conversation_id = i.conversation_id AND p.opted_out = TRUE)
    THEN 'opted_out_blocked'
  ELSE 'duplicate_skipped'
END result, (SELECT id FROM inserted LIMIT 1) follow_up_id;
