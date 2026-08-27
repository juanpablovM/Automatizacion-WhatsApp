-- Close only the exact preserved failed-acceptance artifact; it is never replayable.
-- $1 inbound_event_id, $2 operation_id, $3 handoff_id, $4 operation_key.
WITH target AS MATERIALIZED (
  SELECT
    ie.id AS inbound_event_id,
    eo.id AS operation_id,
    h.id AS handoff_id,
    ie.processing_status AS inbound_status,
    eo.status AS operation_status,
    h.estado AS handoff_status
  FROM inbound_events ie
  JOIN handoffs h ON h.inbound_event_id = ie.id
  JOIN external_operations eo ON eo.entity_id = h.id AND eo.entity_type = 'handoff'
  WHERE ie.id = $1::bigint
    AND eo.id = $2::bigint
    AND h.id = $3::bigint
    AND eo.operation_key = $4::text
    AND eo.operation_type = 'handoff_clickup_notification'
    AND eo.status = 'unknown'
    AND eo.reconciliation_required = TRUE
    AND eo.external_id IS NULL
    AND eo.external_url IS NULL
    AND h.deleted_at IS NULL
    AND h.estado = 'pending'
    AND h.notified_at IS NULL
    AND ie.processing_status = 'failed'
    AND ie.processing_phase = 'dispatching'
  FOR UPDATE OF ie, h, eo
), closed_operation AS (
  UPDATE external_operations
  SET status = 'failed', retry_safe = FALSE, reconciliation_required = FALSE,
      reconciliation_reason = NULL, claim_token = NULL,
      locked_at = NULL, completed_at = NOW(),
      last_error = 'preserved_test_artifact_closed_no_replay', updated_at = NOW()
  WHERE id IN (SELECT operation_id FROM target)
  RETURNING id, entity_id
), retired_handoff AS (
  UPDATE handoffs h
  SET deleted_at = COALESCE(h.deleted_at, NOW()),
      last_notification_error = 'preserved_test_artifact_closed_no_replay',
      updated_at = NOW()
  FROM closed_operation c
  WHERE h.id = c.entity_id
  RETURNING h.id
), failed_inbound AS (
  UPDATE inbound_events ie
  SET processing_status = 'failed',
      processing_phase = 'completed',
      processing_token = NULL,
      failed_at = NOW(),
      failure_reason = 'preserved_test_artifact_closed_no_recovery',
      updated_at = NOW()
  WHERE ie.id IN (SELECT inbound_event_id FROM target)
  RETURNING ie.id
), operation_audit AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'external_operation_preserved_test_artifact_closed', 'external_operation', c.id,
    'system', 'ops-handoff-notification-scheduler', 'failed_test_artifact',
    jsonb_build_object('status', t.operation_status),
    jsonb_build_object('status', 'failed', 'retry_safe', FALSE, 'reconciliation_required', FALSE),
    jsonb_build_object('reason', 'preserved_test_artifact_closed_no_replay')
  FROM closed_operation c JOIN target t ON t.operation_id = c.id
  RETURNING id
), handoff_audit AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_preserved_test_artifact_closed', 'handoff', h.id,
    'system', 'ops-handoff-notification-scheduler', 'failed_test_artifact',
    jsonb_build_object('estado', t.handoff_status),
    jsonb_build_object('deleted', TRUE, 'no_replay', TRUE),
    jsonb_build_object('reason', 'preserved_test_artifact_closed_no_replay')
  FROM retired_handoff h JOIN target t ON t.handoff_id = h.id
  RETURNING id
), inbound_audit AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'inbound_event_preserved_test_artifact_closed', 'inbound_event', ie.id,
    'system', 'ops-handoff-notification-scheduler', 'failed_test_artifact',
    jsonb_build_object('processing_status', t.inbound_status),
    jsonb_build_object('processing_status', 'failed', 'processing_phase', 'completed', 'no_recovery', TRUE),
    jsonb_build_object('reason', 'preserved_test_artifact_closed_no_recovery')
  FROM failed_inbound ie JOIN target t ON t.inbound_event_id = ie.id
  RETURNING id
)
SELECT
  EXISTS (SELECT 1 FROM operation_audit)
  AND EXISTS (SELECT 1 FROM handoff_audit)
  AND EXISTS (SELECT 1 FROM inbound_audit) AS closed;
