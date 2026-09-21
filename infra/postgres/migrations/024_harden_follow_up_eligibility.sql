-- Keep automated follow-ups aligned with the current commercial state.
-- The persisted conversation is authoritative at schedule and send time;
-- workflow payloads can be stale by the time the scheduler runs.
--
-- Provenance: this restores the policy first shipped as 020 on a branch whose
-- 018 collided with the takeover migration of the same number. Renumbering
-- carried 018 and 019 across as 022 and 023 and left this one behind, so the
-- functions below kept running in production while no migration described
-- them and the test database never had them at all. Re-applying is a no-op
-- against a database that already carries the policy.

CREATE INDEX IF NOT EXISTS idx_conversations_contact_identity
ON conversations (source_number_id, phone_number)
WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION follow_up_is_eligible(
  p_conversation_id BIGINT,
  p_motivo TEXT,
  p_phone_number TEXT,
  p_source_number_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM conversations conversation
    JOIN conversation_statuses status
      ON status.id = conversation.conversation_status_id
    WHERE conversation.id = p_conversation_id
      AND conversation.deleted_at IS NULL
      AND conversation.phone_number = p_phone_number
      AND conversation.source_number_id IS NOT DISTINCT FROM p_source_number_id
      AND (
        (p_motivo = 'lead_sin_respuesta' AND status.code = 'waiting_user')
        OR (p_motivo = 'cotizacion_lead' AND status.code = 'handed_to_sales')
      )
  );
$$;

CREATE OR REPLACE FUNCTION follow_up_contact_opted_out(p_conversation_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM conversations target
    JOIN conversations prior
      ON prior.phone_number = target.phone_number
     AND prior.source_number_id IS NOT DISTINCT FROM target.source_number_id
    JOIN follow_up_preferences preference
      ON preference.conversation_id = prior.id
     AND preference.opted_out = TRUE
    WHERE target.id = p_conversation_id
      AND target.deleted_at IS NULL
  );
$$;

-- Repair only rows whose outcome is still safe to determine. Historical
-- ambiguous errors remain quarantined because they may already have reached
-- the provider.
WITH cancelled AS MATERIALIZED (
  UPDATE follow_ups follow_up
  SET estado = 'cancelled',
      result = COALESCE(follow_up.result, 'responded'),
      claim_token = NULL,
      claimed_at = NULL,
      next_retry_at = NULL,
      metadata = follow_up.metadata || jsonb_build_object(
        'cancel_reason', 'conversation_not_eligible',
        'cancelled_by', '024_harden_follow_up_eligibility'
      ),
      updated_at = NOW()
  WHERE follow_up.deleted_at IS NULL
    AND follow_up.estado IN ('pending', 'sending')
    AND NOT follow_up_is_eligible(
      follow_up.conversation_id,
      follow_up.motivo,
      follow_up.phone_number,
      follow_up.source_number_id
    )
  RETURNING follow_up.id, follow_up.conversation_id, follow_up.motivo,
            follow_up.step_dia, follow_up.estado
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id,
  result, before_payload, after_payload, metadata
)
SELECT
  'follow_up_ineligible_cancelled',
  'follow_up',
  cancelled.id,
  'system',
  '024_harden_follow_up_eligibility',
  'cancelled',
  '{}'::jsonb,
  jsonb_build_object('estado', cancelled.estado, 'result', 'responded'),
  jsonb_build_object(
    'conversation_id', cancelled.conversation_id,
    'motivo', cancelled.motivo,
    'step_dia', cancelled.step_dia,
    'reason', 'conversation_not_eligible'
  )
FROM cancelled;

DROP FUNCTION IF EXISTS claim_due_follow_ups(INTEGER, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
CREATE OR REPLACE FUNCTION claim_due_follow_ups(
  p_batch_size INTEGER,
  p_window_start TEXT,
  p_window_end TEXT,
  p_now TIMESTAMPTZ,
  p_claim_stale_seconds INTEGER DEFAULT 900
)
RETURNS TABLE (
  id BIGINT,
  idempotency_key TEXT,
  cycle_key TEXT,
  conversation_id BIGINT,
  opportunity_id BIGINT,
  phone_number TEXT,
  source_number_id BIGINT,
  instance_name TEXT,
  motivo TEXT,
  step_dia SMALLINT,
  scheduled_at TIMESTAMPTZ,
  estado TEXT,
  send_attempt_count INTEGER,
  max_send_attempts INTEGER,
  opted_out BOOLEAN,
  claim_token UUID,
  claimed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_size INTEGER := GREATEST(1, COALESCE(p_batch_size, 50));
  v_window_start TIME := COALESCE(NULLIF(p_window_start, ''), '09:00')::TIME;
  v_window_end TIME := COALESCE(NULLIF(p_window_end, ''), '20:00')::TIME;
  v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_stale_seconds INTEGER := GREATEST(30, COALESCE(p_claim_stale_seconds, 900));
BEGIN
  RETURN QUERY
  WITH target AS (
    SELECT follow_up.id
    FROM follow_ups follow_up
    WHERE follow_up.deleted_at IS NULL
      AND follow_up.opted_out = FALSE
      AND NOT follow_up_contact_opted_out(follow_up.conversation_id)
      AND follow_up_is_eligible(
        follow_up.conversation_id,
        follow_up.motivo,
        follow_up.phone_number,
        follow_up.source_number_id
      )
      AND follow_up.send_attempt_count < follow_up.max_send_attempts
      AND (
        (follow_up.estado = 'pending' AND follow_up.scheduled_at <= v_now)
        OR (
          follow_up.estado = 'error'
          AND follow_up.next_retry_at IS NOT NULL
          AND follow_up.next_retry_at <= v_now
        )
        OR (
          follow_up.estado = 'sending'
          AND COALESCE(follow_up.claimed_at, follow_up.updated_at)
            <= v_now - make_interval(secs => v_stale_seconds)
        )
      )
      AND v_now::TIME >= v_window_start
      AND v_now::TIME <= v_window_end
    ORDER BY COALESCE(follow_up.next_retry_at, follow_up.scheduled_at), follow_up.id
    LIMIT v_batch_size
    FOR UPDATE OF follow_up SKIP LOCKED
  ), claimed AS (
    UPDATE follow_ups follow_up
    SET estado = 'sending',
        claim_token = gen_random_uuid(),
        claimed_at = v_now,
        next_retry_at = NULL,
        updated_at = v_now
    FROM target
    WHERE follow_up.id = target.id
    RETURNING follow_up.*
  )
  SELECT claimed.id, claimed.idempotency_key, claimed.cycle_key,
         claimed.conversation_id, claimed.opportunity_id, claimed.phone_number,
         claimed.source_number_id, number.instance_name, claimed.motivo,
         claimed.step_dia, claimed.scheduled_at, claimed.estado,
         claimed.send_attempt_count, claimed.max_send_attempts,
         claimed.opted_out, claimed.claim_token, claimed.claimed_at
  FROM claimed
  LEFT JOIN whatsapp_numbers number ON number.id = claimed.source_number_id;
END;
$$;
