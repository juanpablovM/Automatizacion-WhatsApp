-- Compare-and-set lifecycle transition. The caller supplies the exact expected
-- state; invalid or stale transitions affect zero rows and must fail closed.
UPDATE conversation_turn_executions execution
SET state = $3::TEXT,
    attempt = CASE WHEN $4::BOOLEAN THEN execution.attempt + 1 ELSE execution.attempt END,
    effect_receipt_refs = COALESCE($5::JSONB, execution.effect_receipt_refs),
    delivery_message_id = COALESCE($6::BIGINT, execution.delivery_message_id),
    delivery_receipt_ref = COALESCE($7::JSONB, execution.delivery_receipt_ref),
    last_error = $8::JSONB,
    updated_at = NOW()
WHERE execution.decision_id = $1::TEXT
  AND execution.state = $2::TEXT
  AND (
    (execution.state = 'prepared' AND $3::TEXT IN ('effects_pending', 'ready_to_commit', 'aborted'))
    OR (execution.state = 'effects_pending' AND $3::TEXT IN ('ready_to_commit', 'aborted', 'reconciliation_required'))
    OR (execution.state = 'reconciliation_required' AND $3::TEXT IN ('effects_pending', 'ready_to_commit', 'aborted'))
    OR (execution.state = 'ready_to_commit' AND $3::TEXT IN ('committed', 'aborted'))
    OR (execution.state = 'committed' AND $3::TEXT = 'delivery_pending')
    OR (execution.state = 'delivery_pending' AND $3::TEXT IN ('delivered', 'reconciliation_required'))
  )
RETURNING execution.*;
