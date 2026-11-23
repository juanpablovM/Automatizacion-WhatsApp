-- A returning customer stays on the same CRM opportunity.
--
-- Owner rule (2026-11-23): "a la misma oportunidad si es que no ha querido
-- iniciar una nueva cotización". After a handoff the orchestrator opens a new
-- conversation for most turns (Fix V3 Route, Persist Conversation State), and
-- the CRM dispatcher only sends messages of conversations announced by a
-- delivered lead.qualified, so the seller never saw the customer writing again.
--
-- 1. conversations.continues_conversation_id: the conversation a new one
--    continues. Set only when the bot opens a conversation and the customer did
--    not ask for a new quote; NULL otherwise, and for every existing row.
-- 2. conversation_continuation_target(source_number_id, phone_number): the one
--    reading of "which conversation does a new one continue", used by both
--    creation points. It is the contact's latest conversation (started_at DESC,
--    id DESC). When that one has no lead of its own, its own link is followed
--    once, so a chain of lead-less conversations always points at the
--    conversation that holds the lead (no recursion needed to read it).
--    NULL when the contact has no previous conversation.
--    Deleting a continued conversation only drops the link (ON DELETE SET
--    NULL); it never blocks the delete.
--
-- The CRM dispatcher (05_select_message_candidates.sql) sends the messages of
-- a linked conversation under the announced conversation id while the linked
-- one has no lead of its own. Additive: no existing data changes.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS continues_conversation_id BIGINT
    REFERENCES conversations (id) ON DELETE SET NULL;

COMMENT ON COLUMN conversations.continues_conversation_id IS
  'Conversation this one continues (returning customer who did not ask for a new quote); see migration 043.';

CREATE INDEX IF NOT EXISTS idx_conversations_continues_conversation_id
  ON conversations (continues_conversation_id)
  WHERE continues_conversation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION conversation_continuation_target(
  p_source_number_id BIGINT,
  p_phone_number TEXT
)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN previous.lead_id IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM leads lead
        WHERE lead.source_conversation_id = previous.id
          AND lead.deleted_at IS NULL
      )
      THEN previous.id
    ELSE COALESCE(previous.continues_conversation_id, previous.id)
  END
  FROM conversations previous
  WHERE previous.source_number_id = p_source_number_id
    AND previous.phone_number = p_phone_number
    AND previous.deleted_at IS NULL
  ORDER BY previous.started_at DESC, previous.id DESC
  LIMIT 1
$$;

COMMIT;
