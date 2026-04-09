-- Inputs esperados:
-- :lead_id
-- :clickup_task_id
-- :clickup_task_url

UPDATE leads l
SET
  clickup_task_id = :clickup_task_id,
  clickup_task_url = :clickup_task_url,
  lead_status_id = ls.id,
  updated_at = NOW()
FROM lead_statuses ls
WHERE l.id = :lead_id
  AND ls.code = 'created_in_clickup'
RETURNING l.*;

