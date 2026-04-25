-- Inputs esperados:
-- :message_id
-- :event_name
-- :result
-- :after_payload_json (nullable)
-- :metadata_json (nullable)

INSERT INTO audit_logs (
  event_name,
  entity_type,
  entity_id,
  actor_type,
  actor_id,
  result,
  before_payload,
  after_payload,
  metadata
)
VALUES (
  :event_name,
  'message',
  :message_id,
  'system',
  'n8n',
  :result,
  '{}'::jsonb,
  COALESCE(:after_payload_json, '{}'::jsonb),
  COALESCE(:metadata_json, '{}'::jsonb)
)
RETURNING *;
