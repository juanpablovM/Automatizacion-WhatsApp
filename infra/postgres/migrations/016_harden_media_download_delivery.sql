-- Durable claim state for the Evolution media download worker.
ALTER TYPE media_download_state ADD VALUE IF NOT EXISTS 'downloading';

ALTER TABLE media_attachments
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_media_attachments_due_download
  ON media_attachments (COALESCE(next_retry_at, created_at), id)
  WHERE deleted_at IS NULL AND download_state IN ('pending', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_attachments_claim_token
  ON media_attachments (claim_token)
  WHERE claim_token IS NOT NULL;
