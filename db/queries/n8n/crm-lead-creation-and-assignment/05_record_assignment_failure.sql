-- Inputs esperados:
-- :lead_id
-- :reason
-- :rotation_id (nullable)

INSERT INTO lead_assignments (
  lead_id,
  seller_id,
  assignment_type,
  assignment_result,
  reason,
  rotation_id
)
VALUES (
  :lead_id,
  NULL,
  'automatic',
  'failed',
  :reason,
  :rotation_id
)
RETURNING *;

