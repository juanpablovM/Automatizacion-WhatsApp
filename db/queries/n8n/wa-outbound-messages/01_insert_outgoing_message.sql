-- Inputs esperados:
-- :conversation_id
-- :lead_id (nullable)
-- :message_type
-- :text_body (nullable)
-- :raw_payload_json

INSERT INTO messages (
  conversation_id,
  lead_id,
  direction,
  message_type,
  delivery_status,
  text_body,
  raw_payload
)
VALUES (
  :conversation_id,
  :lead_id,
  'outgoing',
  :message_type,
  'queued',
  :text_body,
  :raw_payload_json::jsonb
)
RETURNING *;

