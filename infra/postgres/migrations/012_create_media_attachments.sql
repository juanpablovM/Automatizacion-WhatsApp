-- =============================================================================
-- 012_create_media_attachments.sql — Media recibida (fotos/archivos) A-009.
-- -----------------------------------------------------------------------------
-- Registro durable de media entrante de Evolution API: metadata + estado de
-- descarga + hash + ruta interna, idempotente por media_key/url+sha256.
-- El binario en si NO se guarda aqui (solo metadata/hash/ruta relativa).
--
-- ClickUp (CR-014) queda PENDIENTE por diseno: `attached_to` es NULL hasta que
-- exista la integracion real; `attach_pending` marca si el attachment ya
-- descargado espera adjuntarse. NO hay llamado a ClickUp desde este modulo.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_download_state') THEN
    CREATE TYPE media_download_state AS ENUM (
      'pending',
      'downloaded',
      'failed',
      'rejected',
      'expired',
      'exhausted'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS media_attachments (
  id BIGSERIAL PRIMARY KEY,
  media_key TEXT,
  external_url TEXT,
  message_id TEXT NOT NULL,
  inbound_event_id BIGINT REFERENCES inbound_events (id) ON DELETE SET NULL,
  conversation_id BIGINT REFERENCES conversations (id) ON DELETE SET NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers (id) ON DELETE SET NULL,
  instance_name TEXT,
  phone_number TEXT,
  attachment_type TEXT,
  mime_type TEXT,
  filename TEXT,
  file_size BIGINT,
  sha256 TEXT,
  download_state media_download_state NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  storage_path TEXT,
  storage_token TEXT,
  attached_to TEXT,
  attach_pending BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  duplicate_of BIGINT REFERENCES media_attachments (id) ON DELETE SET NULL,
  rejected_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_attachments_media_key
  ON media_attachments (media_key)
  WHERE media_key IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_attachments_url_hash
  ON media_attachments (external_url, sha256)
  WHERE external_url IS NOT NULL AND sha256 IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_attachments_download_queue
  ON media_attachments (download_state, next_retry_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_attachments_message
  ON media_attachments (message_id, deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_attachments_conversation
  ON media_attachments (conversation_id)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_media_attachments_updated_at ON media_attachments;
CREATE TRIGGER set_media_attachments_updated_at
  BEFORE UPDATE ON media_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();