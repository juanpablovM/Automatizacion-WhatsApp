-- Technical-sheet PDFs the v3.1 assistant can send on WhatsApp (task 3c.29).
-- Schema only: the rows (the PDF bytes) are private and are loaded by the
-- private generated SQL db/seeds/private/032_technical_sheet_files.sql
-- (scripts/catalog/technical-sheet-files.mjs). A fresh or test database keeps
-- this table empty, so no sheet is ever offered there.
--
-- One row per (product sku, sheet). A product may have several sheets (one per
-- variant, or two general ones), and two products may list the same document,
-- so a row is keyed by sku plus `sheet_key`, the stable stem of the file name;
-- the assistant refers to a sheet as `sheet:<sheet_key>`. `variant` is the
-- technical_sheet variant the document covers (NULL for a general sheet) and
-- `covers_variants` lists every variant it describes.
--
-- The bytes never leave the database except through the outbound send: the
-- load query exposes only refs to the model, and `Mark Outbound Sending`
-- (db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql) reads
-- the content of the exact reserved file (id + sha256) when it authorizes a
-- document message. A sheet that is replaced or retired is deactivated by the
-- private load (active = FALSE), never deleted, so a message that referenced it
-- stays explainable.
--
-- The size cap (16 MiB) bounds the base64 payload that crosses n8n and
-- Evolution API (/message/sendMedia, JSON body limit 136 MB): a larger file is
-- excluded by the loader and must be recompressed first.
--
-- Down migration: infra/postgres/rollback/032_create_technical_sheet_files.down.sql
CREATE TABLE IF NOT EXISTS technical_sheet_files (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT NOT NULL CHECK (sku ~ '^[a-z0-9-]+$'),
  sheet_key TEXT NOT NULL CHECK (sheet_key ~ '^[a-z0-9-]+$'),
  variant TEXT CHECK (variant IS NULL OR btrim(variant) <> ''),
  covers_variants TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  file_name TEXT NOT NULL CHECK (file_name ~ '^[a-z0-9-]+\.pdf$'),
  mime_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
  content BYTEA NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 16777216),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT technical_sheet_files_sku_sheet_key_key UNIQUE (sku, sheet_key),
  -- The stored bytes are exactly the ones the digest and size describe.
  CONSTRAINT technical_sheet_files_content_integrity CHECK (
    octet_length(content) = size_bytes
    AND encode(sha256(content), 'hex') = sha256
  ),
  CONSTRAINT technical_sheet_files_pdf_content CHECK (substring(content FROM 1 FOR 5) = '\x255044462d'::BYTEA)
);

CREATE INDEX IF NOT EXISTS idx_technical_sheet_files_active_sku
ON technical_sheet_files (sku)
WHERE active;

DROP TRIGGER IF EXISTS set_technical_sheet_files_updated_at ON technical_sheet_files;

CREATE TRIGGER set_technical_sheet_files_updated_at
BEFORE UPDATE ON technical_sheet_files
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
