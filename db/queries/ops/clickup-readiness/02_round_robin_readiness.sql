-- Auditoria read-only del round robin y del fallo no_notifiable_seller.
--
-- La logica productiva solo considera vendedores con:
-- - deleted_at IS NULL
-- - is_active = TRUE
-- - clickup_user_id no vacio
--
-- Si no existe ningun vendedor notificable, CRM - Lead Creation And Assignment
-- registra lead_assignments.reason = 'no_notifiable_seller'.

WITH notifiable_sellers AS (
  SELECT
    s.id,
    s.name,
    s.sort_order,
    s.clickup_user_id,
    s.last_assigned_at
  FROM sellers s
  WHERE s.deleted_at IS NULL
    AND s.is_active = TRUE
    AND NULLIF(BTRIM(s.clickup_user_id), '') IS NOT NULL
),
rotation_state AS (
  SELECT
    ar.id AS rotation_id,
    ar.rotation_key,
    ar.last_seller_id,
    last_seller.name AS last_seller_name,
    ar.next_seller_id,
    next_seller.name AS next_seller_name,
    ar.last_assigned_at,
    CASE
      WHEN ar.next_seller_id IS NULL THEN 'next_seller_not_set'
      WHEN next_seller.id IS NULL THEN 'next_seller_not_notifiable'
      ELSE 'ready'
    END AS rotation_readiness
  FROM assignment_rotations ar
  LEFT JOIN notifiable_sellers last_seller ON last_seller.id = ar.last_seller_id
  LEFT JOIN notifiable_sellers next_seller ON next_seller.id = ar.next_seller_id
),
notifiable_count AS (
  SELECT COUNT(*) AS total_notifiable_sellers
  FROM notifiable_sellers
),
recent_assignment_failures AS (
  SELECT
    COUNT(*) FILTER (WHERE la.reason = 'no_notifiable_seller') AS no_notifiable_seller_failures_7d,
    MAX(la.created_at) FILTER (WHERE la.reason = 'no_notifiable_seller') AS last_no_notifiable_seller_at
  FROM lead_assignments la
  WHERE la.assignment_result = 'failed'
    AND la.created_at >= NOW() - INTERVAL '7 days'
)
SELECT
  rs.rotation_id,
  rs.rotation_key,
  nc.total_notifiable_sellers,
  rs.last_seller_id,
  rs.last_seller_name,
  rs.next_seller_id,
  rs.next_seller_name,
  rs.last_assigned_at,
  rs.rotation_readiness,
  raf.no_notifiable_seller_failures_7d,
  raf.last_no_notifiable_seller_at,
  CASE
    WHEN nc.total_notifiable_sellers = 0 THEN 'BLOCKER: no_notifiable_seller'
    WHEN rs.rotation_id IS NULL THEN 'WARN: rotation_missing_until_first_confirmed_lead'
    WHEN rs.rotation_readiness <> 'ready' THEN 'WARN: next seller will be recalculated by workflow'
    ELSE 'OK'
  END AS operational_status
FROM notifiable_count nc
LEFT JOIN rotation_state rs ON TRUE
LEFT JOIN recent_assignment_failures raf ON TRUE
ORDER BY rs.rotation_key NULLS FIRST;
