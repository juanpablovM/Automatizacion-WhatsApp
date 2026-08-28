-- Complete a claimed ClickUp notification.
-- $1 operation_id, $2 claim_token, $3 outcome, $4 status_code,
-- $5 external_id, $6 external_url, $7 error, $8 response_json, $9 retry_safe.
WITH authorized AS MATERIALIZED (
  SELECT eo.*, h.max_attempts, h.created_at AS handoff_created_at
  FROM external_operations eo
  JOIN handoffs h ON h.id = eo.entity_id AND eo.entity_type = 'handoff'
  WHERE eo.id = $1::bigint
    AND eo.operation_type = 'handoff_clickup_notification'
    AND eo.status = 'processing'
    AND eo.claim_token = $2::uuid
  FOR UPDATE OF eo, h
),
deferral_window AS (
  -- A deferral says "wait, someone has to fix the configuration". Said once
  -- that is reasonable; said forever it is indistinguishable from a healthy
  -- queue, because the deferral branch hands the attempt back and max_attempts
  -- never fires. Handoffs 15 and 16 produced 5223 deferral audit rows over
  -- three days that way, with nobody notified and no alarm.
  --
  -- Six hours is chosen so an unconfigured area surfaces within the same
  -- working day rather than being discovered days later.
  SELECT INTERVAL '6 hours' AS max_wait
),
resolved AS (
  SELECT a.*,
    ($3::text = 'deferred'
      AND NOW() - a.handoff_created_at > w.max_wait) AS deferral_exhausted,
    CASE
      WHEN $3::text = 'succeeded' THEN 'succeeded'
      WHEN $3::text = 'unknown' THEN 'unknown'
      WHEN $3::text = 'deferred'
       AND NOW() - a.handoff_created_at <= w.max_wait THEN 'pending'
      ELSE 'failed'
    END AS final_status,
    ($3::text = 'deferred'
      AND NOW() - a.handoff_created_at <= w.max_wait) AS is_deferred,
    CASE
      WHEN $3::text = 'failed'
       AND $9::boolean
       AND a.attempt_count < a.max_attempts THEN TRUE
      ELSE FALSE
    END AS may_retry
  FROM authorized a CROSS JOIN deferral_window w
),
operation_update AS (
  UPDATE external_operations eo
  SET status = r.final_status,
      attempt_count = CASE WHEN r.is_deferred THEN GREATEST(eo.attempt_count - 1, 0) ELSE eo.attempt_count END,
      external_id = COALESCE(NULLIF($5::text, ''), eo.external_id),
      external_url = COALESCE(NULLIF($6::text, ''), eo.external_url),
      completed_at = CASE WHEN r.final_status = 'succeeded' THEN NOW() ELSE eo.completed_at END,
      last_error = CASE
        WHEN r.is_deferred THEN NULL
        WHEN r.deferral_exhausted
          THEN 'deferred_beyond_window:' || COALESCE(NULLIF($7::text, ''), 'unspecified')
        ELSE NULLIF($7::text, '')
      END,
      response_payload = COALESCE(NULLIF($8::text, '')::jsonb, '{}'::jsonb),
      reconciliation_required = r.final_status = 'unknown',
      reconciliation_reason = CASE WHEN r.final_status = 'unknown' THEN COALESCE(NULLIF($7::text, ''), 'ambiguous_provider_result') ELSE NULL END,
      retry_safe = r.may_retry,
      claim_token = NULL,
      updated_at = NOW()
  FROM resolved r
  WHERE eo.id = r.id
  RETURNING eo.*
),
handoff_update AS (
  UPDATE handoffs h
  SET estado = CASE WHEN r.final_status = 'succeeded' THEN 'notified' ELSE h.estado END,
      notified_at = CASE WHEN r.final_status = 'succeeded' THEN COALESCE(h.notified_at, NOW()) ELSE h.notified_at END,
      notification_attempt_count = GREATEST(
        h.notification_attempt_count,
        CASE WHEN r.is_deferred THEN r.attempt_count - 1 ELSE r.attempt_count END
      ),
      -- The exhausted marker lands on the handoff too. An operator reading the
      -- inventory has to be able to tell "still waiting for configuration"
      -- apart from "gave up waiting" without joining external_operations.
      last_notification_error = CASE
        WHEN r.final_status = 'succeeded' THEN NULL
        WHEN r.deferral_exhausted
          THEN 'deferred_beyond_window:' || COALESCE(NULLIF($7::text, ''), 'unspecified')
        ELSE NULLIF($7::text, '')
      END,
      next_notification_at = CASE
        WHEN r.is_deferred THEN NOW() + INTERVAL '60 seconds'
        WHEN r.may_retry THEN NOW() + (LEAST(3600, 30 * power(2, GREATEST(r.attempt_count - 1, 0))) * INTERVAL '1 second')
        ELSE h.next_notification_at
      END,
      updated_at = NOW()
  FROM resolved r
  WHERE h.id = r.entity_id
  RETURNING h.*
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_clickup_notification', 'handoff', r.entity_id,
    'system', 'ops-handoff-notification-scheduler', CASE
      WHEN r.is_deferred THEN 'deferred_config'
      WHEN r.deferral_exhausted THEN 'deferred_config_exhausted'
      ELSE r.final_status
    END,
    jsonb_build_object('attempt_count', r.attempt_count - 1),
    jsonb_build_object('attempt_count', r.attempt_count, 'estado', hu.estado),
    jsonb_build_object(
      'operation_id', r.id,
      'http_status', NULLIF($4::text, '')::integer,
      'retry_safe', r.may_retry,
      'reconciliation_required', r.final_status = 'unknown'
    )
  FROM resolved r
  JOIN handoff_update hu ON hu.id = r.entity_id
  RETURNING id
)
SELECT
  r.entity_id AS handoff_id,
  r.id AS operation_id,
  CASE
      WHEN r.is_deferred THEN 'deferred_config'
      WHEN r.deferral_exhausted THEN 'deferred_config_exhausted'
      ELSE r.final_status
    END AS result,
  r.may_retry AS retry_safe,
  hu.estado AS handoff_estado,
  hu.notification_attempt_count,
  hu.next_notification_at,
  (r.final_status = 'unknown') AS reconciliation_required
FROM resolved r
JOIN handoff_update hu ON hu.id = r.entity_id;
