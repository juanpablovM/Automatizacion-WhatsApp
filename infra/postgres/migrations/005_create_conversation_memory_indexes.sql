CREATE INDEX IF NOT EXISTS idx_messages_conversation_history
ON messages (conversation_id, created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_conversation_state_history
ON audit_logs (entity_id, created_at DESC, id DESC)
WHERE entity_type = 'conversation'
  AND event_name = 'conversation_state_evaluated';
