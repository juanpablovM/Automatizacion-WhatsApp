-- One-time repair for legacy conversation state drift.
-- Idempotent: every update targets only rows that still violate its invariant.

-- 1. Expire stale waiting conversations without touching recent activity.
WITH stale AS (
  SELECT c.id,
    jsonb_build_object(
      'status', cs.code,
      'current_step', c.current_step,
      'pending_question_key', c.pending_question_key,
      'last_message_at', c.last_message_at
    ) AS before_payload
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  WHERE c.deleted_at IS NULL
    AND cs.code = 'waiting_user'
    AND c.last_message_at < NOW() - INTERVAL '24 hours'
  FOR UPDATE OF c
), repaired AS (
  UPDATE conversations c
  SET conversation_status_id = target.id,
      current_step = NULL,
      pending_question_key = NULL,
      closed_at = COALESCE(c.closed_at, NOW()),
      updated_at = NOW()
  FROM stale s
  CROSS JOIN conversation_statuses target
  WHERE c.id = s.id
    AND target.code = 'inactive_timeout'
  RETURNING c.id, s.before_payload, c.last_message_at, c.closed_at
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'legacy_conversation_timeout_repaired', 'conversation', r.id, 'system',
  'migration_008', 'success', r.before_payload,
  jsonb_build_object(
    'status', 'inactive_timeout',
    'current_step', NULL,
    'pending_question_key', NULL,
    'closed_at', r.closed_at
  ),
  jsonb_build_object('rule', 'waiting_user_older_than_24h', 'last_message_at', r.last_message_at)
FROM repaired r;

-- 2. Canonicalize terminal states. A terminal conversation cannot retain an
-- unanswered question; its step is canonical rather than a resumable payload.
WITH inconsistent AS (
  SELECT c.id, cs.code,
    jsonb_build_object(
      'status', cs.code,
      'current_step', c.current_step,
      'pending_question_key', c.pending_question_key,
      'closed_at', c.closed_at
    ) AS before_payload
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  WHERE c.deleted_at IS NULL
    AND cs.code IN ('handed_to_sales', 'escalation_required', 'closed', 'inactive_timeout')
    AND (
      c.pending_question_key IS NOT NULL
      OR CASE cs.code
        WHEN 'handed_to_sales' THEN COALESCE(c.current_step, '') <> 'complete'
        WHEN 'escalation_required' THEN COALESCE(c.current_step, '') <> 'escalation'
        ELSE c.current_step IS NOT NULL
      END
      OR (cs.code IN ('closed', 'inactive_timeout') AND c.closed_at IS NULL)
    )
  FOR UPDATE OF c
), repaired AS (
  UPDATE conversations c
  SET pending_question_key = NULL,
      current_step = CASE i.code
        WHEN 'handed_to_sales' THEN 'complete'
        WHEN 'escalation_required' THEN 'escalation'
        ELSE NULL
      END,
      closed_at = CASE
        WHEN i.code IN ('closed', 'inactive_timeout') THEN COALESCE(c.closed_at, NOW())
        ELSE c.closed_at
      END,
      updated_at = NOW()
  FROM inconsistent i
  WHERE c.id = i.id
  RETURNING c.id, i.code, i.before_payload, c.current_step, c.closed_at
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'legacy_terminal_state_repaired', 'conversation', r.id, 'system',
  'migration_008', 'success', r.before_payload,
  jsonb_build_object(
    'status', r.code,
    'current_step', r.current_step,
    'pending_question_key', NULL,
    'closed_at', r.closed_at
  ),
  jsonb_build_object('rule', 'terminal_state_canonicalization')
FROM repaired r;

-- 3. Preserve the newest resumable conversation for each business number and
-- customer number. Older duplicates are closed; a sole recent conversation is
-- never touched.
WITH ranked AS (
  SELECT
    c.id,
    ROW_NUMBER() OVER (
      PARTITION BY c.source_number_id, c.phone_number
      ORDER BY c.last_message_at DESC, c.started_at DESC, c.id DESC
    ) AS position,
    COUNT(*) OVER (PARTITION BY c.source_number_id, c.phone_number) AS active_count,
    cs.code AS status_code
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  WHERE c.deleted_at IS NULL
    AND c.source_number_id IS NOT NULL
    AND cs.code IN ('active', 'waiting_user', 'out_of_flow')
), duplicates AS (
  SELECT c.id,
    jsonb_build_object(
      'status', r.status_code,
      'current_step', c.current_step,
      'pending_question_key', c.pending_question_key,
      'last_message_at', c.last_message_at
    ) AS before_payload
  FROM ranked r
  JOIN conversations c ON c.id = r.id
  WHERE r.active_count > 1 AND r.position > 1
  FOR UPDATE OF c
), repaired AS (
  UPDATE conversations c
  SET conversation_status_id = target.id,
      current_step = NULL,
      pending_question_key = NULL,
      closed_at = COALESCE(c.closed_at, NOW()),
      updated_at = NOW()
  FROM duplicates d
  CROSS JOIN conversation_statuses target
  WHERE c.id = d.id
    AND target.code = 'closed'
  RETURNING c.id, d.before_payload, c.closed_at
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'legacy_duplicate_conversation_closed', 'conversation', r.id, 'system',
  'migration_008', 'success', r.before_payload,
  jsonb_build_object(
    'status', 'closed',
    'current_step', NULL,
    'pending_question_key', NULL,
    'closed_at', r.closed_at
  ),
  jsonb_build_object('rule', 'keep_newest_per_source_and_phone')
FROM repaired r;
