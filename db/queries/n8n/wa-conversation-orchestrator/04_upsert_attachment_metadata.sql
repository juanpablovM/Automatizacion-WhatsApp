-- Inputs esperados:
-- :message_id
-- :attachment_type
-- :mime_type (nullable)
-- :filename (nullable)
-- :external_media_id (nullable)
-- :external_url (nullable)
-- :sha256 (nullable)
-- :file_size (nullable)

INSERT INTO message_attachments (
  message_id,
  attachment_type,
  mime_type,
  filename,
  external_media_id,
  external_url,
  sha256,
  file_size
)
VALUES (
  :message_id,
  :attachment_type,
  :mime_type,
  :filename,
  :external_media_id,
  :external_url,
  :sha256,
  :file_size
)
RETURNING *;

