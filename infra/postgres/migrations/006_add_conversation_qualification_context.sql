ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS qualification_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS pending_question_key TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS qualification_context JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE INDEX IF NOT EXISTS idx_conversations_pending_question
ON conversations (pending_question_key)
WHERE deleted_at IS NULL AND pending_question_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_qualification_context
ON conversations USING GIN (qualification_context);

CREATE INDEX IF NOT EXISTS idx_leads_qualification_context
ON leads USING GIN (qualification_context);
