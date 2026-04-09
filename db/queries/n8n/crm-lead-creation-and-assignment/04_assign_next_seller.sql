-- Inputs esperados:
-- :lead_id
-- :rotation_key

WITH target_rotation AS (
  SELECT
    ar.id,
    ar.rotation_key,
    ar.next_seller_id
  FROM assignment_rotations ar
  WHERE ar.rotation_key = :rotation_key
  FOR UPDATE
),
selected_seller AS (
  SELECT
    s.id,
    s.name,
    s.whatsapp_number,
    s.clickup_user_id,
    s.sort_order,
    tr.id AS rotation_id
  FROM target_rotation tr
  JOIN sellers s ON s.id = tr.next_seller_id
  WHERE s.deleted_at IS NULL
    AND s.is_active = TRUE
  UNION ALL
  SELECT
    s.id,
    s.name,
    s.whatsapp_number,
    s.clickup_user_id,
    s.sort_order,
    tr.id AS rotation_id
  FROM target_rotation tr
  JOIN LATERAL (
    SELECT *
    FROM sellers
    WHERE deleted_at IS NULL
      AND is_active = TRUE
    ORDER BY sort_order ASC
    LIMIT 1
  ) s ON TRUE
  WHERE NOT EXISTS (
    SELECT 1
    FROM sellers sx
    WHERE sx.id = tr.next_seller_id
      AND sx.deleted_at IS NULL
      AND sx.is_active = TRUE
  )
  LIMIT 1
),
next_candidate AS (
  SELECT
    COALESCE(
      (
        SELECT s2.id
        FROM sellers s2
        JOIN selected_seller cur ON TRUE
        WHERE s2.deleted_at IS NULL
          AND s2.is_active = TRUE
          AND s2.sort_order > cur.sort_order
        ORDER BY s2.sort_order ASC
        LIMIT 1
      ),
      (
        SELECT s3.id
        FROM sellers s3
        WHERE s3.deleted_at IS NULL
          AND s3.is_active = TRUE
        ORDER BY s3.sort_order ASC
        LIMIT 1
      )
    ) AS next_seller_id
),
updated_seller AS (
  UPDATE sellers s
  SET
    last_assigned_at = NOW(),
    updated_at = NOW()
  FROM selected_seller ss
  WHERE s.id = ss.id
  RETURNING s.id, s.name, s.whatsapp_number, s.clickup_user_id
),
updated_rotation AS (
  UPDATE assignment_rotations ar
  SET
    last_seller_id = ss.id,
    next_seller_id = nc.next_seller_id,
    last_assigned_at = NOW(),
    updated_at = NOW()
  FROM selected_seller ss, next_candidate nc
  WHERE ar.id = ss.rotation_id
  RETURNING ar.id, ar.rotation_key, ar.last_seller_id, ar.next_seller_id
),
updated_lead AS (
  UPDATE leads l
  SET
    assigned_seller_id = ss.id,
    assigned_at = NOW(),
    lead_status_id = ls.id,
    updated_at = NOW()
  FROM selected_seller ss
  JOIN lead_statuses ls ON ls.code = 'assigned'
  WHERE l.id = :lead_id
  RETURNING l.id, l.assigned_seller_id, l.assigned_at
),
insert_assignment AS (
  INSERT INTO lead_assignments (
    lead_id,
    seller_id,
    assignment_type,
    assignment_result,
    reason,
    rotation_id
  )
  SELECT
    :lead_id,
    ss.id,
    'automatic',
    'assigned',
    'round_robin',
    ss.rotation_id
  FROM selected_seller ss
  RETURNING *
)
SELECT
  ul.id AS lead_id,
  us.id AS seller_id,
  us.name AS seller_name,
  us.whatsapp_number AS seller_whatsapp_number,
  us.clickup_user_id,
  ur.id AS rotation_id,
  ur.next_seller_id
FROM updated_lead ul
JOIN updated_seller us ON TRUE
JOIN updated_rotation ur ON TRUE;

