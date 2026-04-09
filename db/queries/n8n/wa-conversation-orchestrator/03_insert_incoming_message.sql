-- Inputs esperados:
-- :conversation_id
-- :lead_id (nullable)
-- :external_message_id (nullable)
-- :external_timestamp (nullable, formato timestamptz)
-- :message_type
-- :text_body (nullable)
-- :raw_payload_json

INSERT INTO messages (
  conversation_id,
  lead_id,
  direction,
  message_type,
  external_message_id,
  external_timestamp,
  delivery_status,
  text_body,
  raw_payload
)
VALUES (
  :conversation_id,
  :lead_id,
  'incoming',
  :message_type,
  :external_message_id,
  :external_timestamp,
  NULL,
  :text_body,
  :raw_payload_json::jsonb
)
RETURNING *;

