-- Inputs esperados:
-- :lead_id

UPDATE leads l
SET
  lead_status_id = ls.id,
  updated_at = NOW()
FROM lead_statuses ls
WHERE l.id = :lead_id
  AND ls.code = 'error'
RETURNING l.*;

