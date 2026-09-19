BEGIN;

-- Prevent an inbound insert from racing the safety check and archive. The
-- timeout keeps this operational command from waiting behind active writers.
SET LOCAL lock_timeout = '3s';
LOCK TABLE inbound_events IN SHARE MODE;

CREATE TEMP TABLE controlled_test_reset_input ON COMMIT DROP AS
SELECT :'phone_number'::text AS phone_number;

DO $controlled_test_reset$
DECLARE
  queued_count bigint;
  closed_status_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO closed_status_count
  FROM conversation_statuses
  WHERE code = 'closed';

  IF closed_status_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one closed conversation status, found %',
      closed_status_count;
  END IF;

  SELECT COUNT(*)
  INTO queued_count
  FROM inbound_events
  WHERE phone_number = (
    SELECT phone_number FROM controlled_test_reset_input
  )
    AND processing_status IN ('received', 'processing');

  IF queued_count > 0 THEN
    RAISE EXCEPTION
      'controlled test session has % queued/processing inbound event(s)',
      queued_count;
  END IF;
END
$controlled_test_reset$;

-- Hold every follow-up of this number before deciding anything, so a scheduler
-- tick cannot claim one between the check and the cancellation below. A row
-- already claimed may have reached the provider, so the reset refuses instead
-- of rewriting an outcome it cannot observe.
DO $controlled_test_reset$
DECLARE
  in_flight_count bigint;
BEGIN
  PERFORM 1
  FROM follow_ups AS follow_up
  WHERE follow_up.phone_number = (
      SELECT phone_number FROM controlled_test_reset_input
    )
    AND follow_up.deleted_at IS NULL
  FOR UPDATE;

  SELECT COUNT(*)
  INTO in_flight_count
  FROM follow_ups AS follow_up
  WHERE follow_up.phone_number = (
      SELECT phone_number FROM controlled_test_reset_input
    )
    AND follow_up.deleted_at IS NULL
    AND follow_up.estado = 'sending';

  IF in_flight_count > 0 THEN
    RAISE EXCEPTION
      'controlled test session has % follow-up(s) in flight',
      in_flight_count;
  END IF;
END
$controlled_test_reset$;

-- enforce_handoff_before_conversation_terminal (migration 015) refuses a
-- terminal transition while a handoff is still pending, and refuses an
-- escalated conversation that never got one notified. This reset never mutates
-- handoff rows, so it cannot clear either condition: diagnosing it here names
-- the blocking conversations and the way out, instead of letting the trigger
-- abort the transaction with a bare id halfway through the work.
DO $controlled_test_reset$
DECLARE
  blocked_handoff_count bigint;
  blocked_conversation_ids text;
BEGIN
  SELECT COUNT(*), string_agg(blocked.id::text, ', ' ORDER BY blocked.id)
  INTO blocked_handoff_count, blocked_conversation_ids
  FROM (
    SELECT conversation.id
    FROM conversations AS conversation
    JOIN conversation_statuses AS status
      ON status.id = conversation.conversation_status_id
    WHERE conversation.phone_number = (
        SELECT phone_number FROM controlled_test_reset_input
      )
      AND conversation.deleted_at IS NULL
      AND status.code <> 'closed'
      AND (
        EXISTS (
          SELECT 1
          FROM handoffs AS handoff
          WHERE handoff.conversation_id = conversation.id
            AND handoff.deleted_at IS NULL
            AND handoff.estado = 'pending'
        )
        OR (
          status.code = 'escalation_required'
          AND NOT EXISTS (
            SELECT 1
            FROM handoffs AS handoff
            WHERE handoff.conversation_id = conversation.id
              AND handoff.deleted_at IS NULL
              AND handoff.estado IN ('notified', 'acknowledged', 'resolved')
          )
        )
      )
  ) AS blocked;

  IF blocked_handoff_count > 0 THEN
    RAISE EXCEPTION
      'controlled test session has % conversation(s) whose handoff is not notified yet',
      blocked_handoff_count
      USING HINT =
        'Blocking conversation(s): ' || blocked_conversation_ids
        || '. The seller notification dispatch has to notify those handoffs, or they'
        || ' must be resolved, before this reset can run. The reset never mutates'
        || ' handoff rows, so it cannot clear this on its own.';
  END IF;
END
$controlled_test_reset$;

-- Close every conversation that is not already closed. Enumerating the open
-- status codes left handed_to_sales, escalation_required and inactive_timeout
-- sessions behind, so the reset was never a full reset of the test number.
WITH closed_status AS (
  SELECT id FROM conversation_statuses WHERE code = 'closed'
), archived AS (
  UPDATE conversations AS conversation
  SET conversation_status_id = closed_status.id,
      closed_at = COALESCE(conversation.closed_at, NOW()),
      updated_at = NOW()
  FROM closed_status, conversation_statuses AS previous_status
  WHERE conversation.phone_number = (
      SELECT phone_number FROM controlled_test_reset_input
    )
    AND conversation.deleted_at IS NULL
    AND previous_status.id = conversation.conversation_status_id
    AND previous_status.code <> 'closed'
  RETURNING conversation.id, previous_status.code AS previous_status_code
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'controlled_test_session_archived',
  'conversation',
  archived.id,
  'system',
  'reset-controlled-test-session',
  'closed',
  jsonb_build_object('conversation_status_code', archived.previous_status_code),
  jsonb_build_object('conversation_status_code', 'closed'),
  jsonb_build_object('reason', 'controlled_test_session_reset')
FROM archived;

-- Cancel the cadence this number still has scheduled. The previous estado is
-- captured before the write because RETURNING would only echo the new one.
-- result stays NULL: nothing was ever sent, so any delivery outcome would be
-- a lie in the follow-up history.
WITH scheduled AS MATERIALIZED (
  SELECT follow_up.id, follow_up.estado
  FROM follow_ups AS follow_up
  WHERE follow_up.phone_number = (
      SELECT phone_number FROM controlled_test_reset_input
    )
    AND follow_up.deleted_at IS NULL
    AND follow_up.estado IN ('pending', 'error')
), cancelled AS (
  UPDATE follow_ups AS follow_up
  SET estado = 'cancelled',
      claim_token = NULL,
      claimed_at = NULL,
      next_retry_at = NULL,
      metadata = follow_up.metadata || jsonb_build_object(
        'cancel_reason', 'controlled_test_session_reset',
        'cancelled_by', 'reset-controlled-test-session'
      ),
      updated_at = NOW()
  FROM scheduled
  WHERE scheduled.id = follow_up.id
  RETURNING follow_up.id, follow_up.conversation_id, follow_up.motivo,
            follow_up.step_dia, scheduled.estado AS previous_estado
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'controlled_test_follow_up_cancelled',
  'follow_up',
  cancelled.id,
  'system',
  'reset-controlled-test-session',
  'cancelled',
  jsonb_build_object('estado', cancelled.previous_estado),
  jsonb_build_object('estado', 'cancelled'),
  jsonb_build_object(
    'conversation_id', cancelled.conversation_id,
    'motivo', cancelled.motivo,
    'step_dia', cancelled.step_dia,
    'reason', 'controlled_test_session_reset'
  )
FROM cancelled;

DO $controlled_test_reset$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversations AS conversation
    JOIN conversation_statuses AS status
      ON status.id = conversation.conversation_status_id
    WHERE conversation.phone_number = (
        SELECT phone_number FROM controlled_test_reset_input
      )
      AND conversation.deleted_at IS NULL
      AND status.code <> 'closed'
  ) THEN
    RAISE EXCEPTION 'controlled test session reset did not close every open conversation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM follow_ups AS follow_up
    WHERE follow_up.phone_number = (
        SELECT phone_number FROM controlled_test_reset_input
      )
      AND follow_up.deleted_at IS NULL
      AND follow_up.estado IN ('pending', 'sending', 'error')
  ) THEN
    RAISE EXCEPTION 'controlled test session reset did not cancel every scheduled follow-up';
  END IF;
END
$controlled_test_reset$;

COMMIT;
