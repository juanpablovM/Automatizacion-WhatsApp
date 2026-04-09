-- Inputs esperados:
-- :rotation_key

INSERT INTO assignment_rotations (
  rotation_key,
  next_seller_id,
  created_at,
  updated_at
)
SELECT
  :rotation_key,
  s.id,
  NOW(),
  NOW()
FROM sellers s
WHERE s.deleted_at IS NULL
  AND s.is_active = TRUE
ORDER BY s.sort_order ASC
LIMIT 1
ON CONFLICT (rotation_key) DO NOTHING;

