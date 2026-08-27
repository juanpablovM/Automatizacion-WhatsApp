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

WITH closed_status AS (
  SELECT id FROM conversation_statuses WHERE code = 'closed'
), archived AS (
  UPDATE conversations AS conversation
  SET conversation_status_id = closed_status.id,
      closed_at = COALESCE(conversation.closed_at, NOW()),
      updated_at = NOW()
  FROM closed_status
  WHERE conversation.phone_number = (
      SELECT phone_number FROM controlled_test_reset_input
    )
    AND conversation.deleted_at IS NULL
    AND conversation.conversation_status_id IN (
      SELECT id FROM conversation_statuses
      WHERE code IN ('active', 'waiting_user', 'out_of_flow')
    )
  RETURNING conversation.id
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
  '{}'::jsonb,
  jsonb_build_object('conversation_status_code', 'closed'),
  jsonb_build_object('reason', 'controlled_test_session_reset')
FROM archived;

DO $controlled_test_reset$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversations AS conversation
    WHERE conversation.phone_number = (
        SELECT phone_number FROM controlled_test_reset_input
      )
      AND conversation.deleted_at IS NULL
      AND conversation.conversation_status_id IN (
        SELECT id FROM conversation_statuses
        WHERE code IN ('active', 'waiting_user', 'out_of_flow')
      )
  ) THEN
    RAISE EXCEPTION 'controlled test session reset did not close every active conversation';
  END IF;
END
$controlled_test_reset$;

COMMIT;
