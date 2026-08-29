-- =============================================================================
-- close-undeliverable-area-handoffs.sql — Retire handoffs the ClickUp
-- dispatcher can never deliver, so the scheduler stops re-deferring them.
-- -----------------------------------------------------------------------------
-- Context: prepare-handoff-clickup-task accepts only area = 'sales'. Any other
-- area produces HANDOFF_CLICKUP_AREA_unsupported:<area> and the dispatch is
-- reported as 'deferred'. 03_complete_notification.sql treats a deferral as a
-- wait for configuration: it gives the attempt back
-- (attempt_count = GREATEST(attempt_count - 1, 0)) and reschedules
-- next_notification_at to NOW() + 60 seconds. Because the attempt is never
-- consumed, the max_attempts guard never fires and the handoff is retried once
-- a minute forever, with no alarm and no terminal state.
--
-- Observed on 2026-08-27: handoffs 15 and 16 had produced 4645 deferred_config
-- audit rows since 2026-08-24, roughly 1440 per day, writing into the same
-- tables used to diagnose the system.
--
-- This backfill closes only rows in that exact shape. It does NOT fix the
-- underlying defect: the deferral still needs a cap, and the product decision
-- about whether the bot should promise derivation for an area with no delivery
-- path is separate. This only stops the bleeding and makes the inventory honest.
--
-- On estado: the schema admits only pending, notified, acknowledged and
-- resolved, and none of them is true for these rows. Nobody was notified and
-- nobody resolved anything. Rather than assert a false state, the handoff keeps
-- estado = 'pending' and is soft deleted; deleted_at is what removes it from
-- 02_claim_notification.sql, whose candidate set requires deleted_at IS NULL.
-- The row survives as evidence.
--
-- Idempotent: a second run finds no candidates, because the first one sets
-- deleted_at and replaces the marker.
-- Selective: it never touches a sales handoff, a handoff the dispatcher has not
-- rejected yet, or one that was already notified.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

WITH candidates AS MATERIALIZED (
  SELECT
    handoff.id AS handoff_id,
    handoff.area,
    handoff.estado AS handoff_status,
    handoff.last_notification_error AS handoff_error,
    operation.id AS operation_id,
    operation.status AS operation_status
  FROM handoffs handoff
  JOIN external_operations operation
    ON operation.entity_type = 'handoff'
   AND operation.entity_id = handoff.id
   AND operation.operation_type = 'handoff_clickup_notification'
  WHERE handoff.deleted_at IS NULL
    AND handoff.estado = 'pending'
    AND handoff.notified_at IS NULL
    -- The dispatcher must have actually rejected the area. Without this marker
    -- the pipeline still owns the row and closing it here would hide it.
    AND handoff.last_notification_error LIKE 'HANDOFF_CLICKUP_AREA_unsupported:%'
    AND operation.status = 'pending'
    AND operation.external_id IS NULL
    AND operation.external_url IS NULL
  FOR UPDATE OF handoff, operation
),
closed_operation AS (
  UPDATE external_operations operation
  SET status = 'failed',
      retry_safe = FALSE,
      reconciliation_required = FALSE,
      reconciliation_reason = NULL,
      claim_token = NULL,
      locked_at = NULL,
      completed_at = NOW(),
      last_error = 'closed_undeliverable_area_no_replay',
      updated_at = NOW()
  FROM candidates candidate
  WHERE operation.id = candidate.operation_id
  RETURNING operation.id, operation.entity_id
),
retired_handoff AS (
  UPDATE handoffs handoff
  SET deleted_at = NOW(),
      last_notification_error = 'closed_undeliverable_area_no_replay',
      updated_at = NOW()
  FROM closed_operation closed
  WHERE handoff.id = closed.entity_id
  RETURNING handoff.id
),
handoff_audit AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_closed_undeliverable_area', 'handoff', retired.id,
    'system', 'ops-handoff-notification-scheduler', 'closed_undeliverable_area',
    jsonb_build_object(
      'estado', candidate.handoff_status,
      'last_notification_error', candidate.handoff_error
    ),
    jsonb_build_object(
      'estado', candidate.handoff_status,
      'deleted', TRUE,
      'no_replay', TRUE,
      'last_notification_error', 'closed_undeliverable_area_no_replay'
    ),
    jsonb_build_object(
      'reason', 'clickup_dispatch_supports_sales_only',
      'area', candidate.area,
      'operation_id', candidate.operation_id
    )
  FROM retired_handoff retired
  JOIN candidates candidate ON candidate.handoff_id = retired.id
  RETURNING id
),
operation_audit AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'external_operation_closed_undeliverable_area', 'external_operation', closed.id,
    'system', 'ops-handoff-notification-scheduler', 'closed_undeliverable_area',
    jsonb_build_object('status', candidate.operation_status),
    jsonb_build_object('status', 'failed', 'retry_safe', FALSE, 'reconciliation_required', FALSE),
    jsonb_build_object(
      'reason', 'clickup_dispatch_supports_sales_only',
      'area', candidate.area,
      'handoff_id', candidate.handoff_id
    )
  FROM closed_operation closed
  JOIN candidates candidate ON candidate.operation_id = closed.id
  RETURNING id
)
SELECT
  (SELECT COUNT(*)::int FROM retired_handoff) AS handoffs_closed,
  (SELECT COUNT(*)::int FROM closed_operation) AS operations_closed,
  (SELECT COUNT(*)::int FROM handoff_audit) AS handoff_audits,
  (SELECT COUNT(*)::int FROM operation_audit) AS operation_audits;

COMMIT;
