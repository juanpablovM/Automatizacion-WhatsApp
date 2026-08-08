-- Durable ClickUp delivery queue and database closure gate for handoffs.

ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS next_notification_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_handoffs_notification_due
ON handoffs (next_notification_at, id)
WHERE deleted_at IS NULL AND estado = 'pending';

ALTER TABLE external_operations
  ADD COLUMN IF NOT EXISTS claim_token UUID;

CREATE INDEX IF NOT EXISTS idx_external_operations_handoff_claim
ON external_operations (status, locked_at)
WHERE operation_type = 'handoff_clickup_notification';

CREATE OR REPLACE FUNCTION enforce_handoff_before_conversation_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_status TEXT;
  new_status TEXT;
BEGIN
  IF NEW.conversation_status_id IS NOT DISTINCT FROM OLD.conversation_status_id THEN
    RETURN NEW;
  END IF;

  SELECT code INTO old_status FROM conversation_statuses WHERE id = OLD.conversation_status_id;
  SELECT code INTO new_status FROM conversation_statuses WHERE id = NEW.conversation_status_id;

  IF new_status IN ('closed', 'inactive_timeout') THEN
    IF EXISTS (
      SELECT 1 FROM handoffs h
      WHERE h.conversation_id = OLD.id
        AND h.deleted_at IS NULL
        AND h.estado = 'pending'
    ) OR (old_status = 'escalation_required' AND NOT EXISTS (
      SELECT 1 FROM handoffs h
      WHERE h.conversation_id = OLD.id
        AND h.deleted_at IS NULL
        AND h.estado IN ('notified', 'acknowledged', 'resolved')
    )) THEN
      RAISE EXCEPTION 'conversation % cannot become terminal before every handoff is notified', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_handoff_before_terminal ON conversations;
CREATE TRIGGER enforce_handoff_before_terminal
BEFORE UPDATE OF conversation_status_id ON conversations
FOR EACH ROW EXECUTE FUNCTION enforce_handoff_before_conversation_terminal();
