-- Inputs esperados:
-- :message_id
-- :delivery_status
-- :external_message_id (nullable)

UPDATE messages
SET
  delivery_status = :delivery_status,
  external_message_id = COALESCE(:external_message_id, external_message_id),
  updated_at = NOW()
WHERE id = :message_id
RETURNING *;

