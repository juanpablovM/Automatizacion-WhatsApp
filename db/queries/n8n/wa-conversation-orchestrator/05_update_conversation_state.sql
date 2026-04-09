-- Inputs esperados:
-- :conversation_id
-- :current_step (nullable)
-- :conversation_status_code
-- :lead_id (nullable)

UPDATE conversations c
SET
  current_step = COALESCE(:current_step, c.current_step),
  conversation_status_id = cs.id,
  lead_id = COALESCE(:lead_id, c.lead_id),
  last_message_at = NOW(),
  handed_to_sales_at = CASE
    WHEN cs.code = 'handed_to_sales' THEN COALESCE(c.handed_to_sales_at, NOW())
    ELSE c.handed_to_sales_at
  END,
  closed_at = CASE
    WHEN cs.code IN ('closed', 'inactive_timeout') THEN COALESCE(c.closed_at, NOW())
    ELSE c.closed_at
  END,
  updated_at = NOW()
FROM conversation_statuses cs
WHERE c.id = :conversation_id
  AND cs.code = :conversation_status_code
RETURNING c.*;

