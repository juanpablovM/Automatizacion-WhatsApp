-- Inputs esperados:
-- :phone_number
-- :source_number_id (nullable)
-- :current_step
-- :lead_id (nullable)

INSERT INTO conversations (
  lead_id,
  source_number_id,
  phone_number,
  conversation_status_id,
  current_step,
  started_at,
  last_message_at
)
SELECT
  :lead_id,
  :source_number_id,
  :phone_number,
  cs.id,
  :current_step,
  NOW(),
  NOW()
FROM conversation_statuses cs
WHERE cs.code = 'active'
RETURNING *;

