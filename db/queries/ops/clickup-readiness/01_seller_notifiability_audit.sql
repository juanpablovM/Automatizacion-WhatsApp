-- Auditoria read-only de vendedores para readiness ClickUp.
--
-- Objetivo:
-- - separar vendedores notificables de vendedores incompletos o de prueba
-- - confirmar que todo vendedor que pueda recibir leads tenga clickup_user_id
-- - detectar valores duplicados que romperian ownership claro en ClickUp
--
-- Uso sugerido:
-- docker compose --env-file .env exec -T postgres \
--   psql -U postgres -d crm_whatsapp_app \
--   -f db/queries/ops/clickup-readiness/01_seller_notifiability_audit.sql

WITH seller_flags AS (
  SELECT
    s.id,
    s.name,
    s.whatsapp_number,
    s.clickup_user_id,
    s.is_active,
    s.sort_order,
    s.last_assigned_at,
    s.deleted_at,
    CASE
      WHEN s.deleted_at IS NOT NULL THEN 'deleted'
      WHEN s.is_active IS NOT TRUE THEN 'inactive'
      WHEN NULLIF(BTRIM(s.clickup_user_id), '') IS NULL THEN 'missing_clickup_user_id'
      ELSE 'notifiable'
    END AS readiness_status,
    CASE
      WHEN s.name ~* '(test|prueba|demo|qa)' THEN TRUE
      WHEN COALESCE(s.whatsapp_number, '') ~ '(0000|1111|1234|9999)' THEN TRUE
      ELSE FALSE
    END AS looks_like_test_data
  FROM sellers s
),
clickup_duplicates AS (
  SELECT
    clickup_user_id,
    COUNT(*) AS seller_count
  FROM seller_flags
  WHERE readiness_status = 'notifiable'
  GROUP BY clickup_user_id
  HAVING COUNT(*) > 1
)
SELECT
  sf.id,
  sf.name,
  sf.whatsapp_number,
  sf.clickup_user_id,
  sf.is_active,
  sf.sort_order,
  sf.last_assigned_at,
  sf.deleted_at,
  sf.readiness_status,
  sf.looks_like_test_data,
  COALESCE(cd.seller_count, 0) AS active_sellers_sharing_clickup_user_id
FROM seller_flags sf
LEFT JOIN clickup_duplicates cd ON cd.clickup_user_id = sf.clickup_user_id
ORDER BY
  CASE sf.readiness_status
    WHEN 'notifiable' THEN 1
    WHEN 'missing_clickup_user_id' THEN 2
    WHEN 'inactive' THEN 3
    ELSE 4
  END,
  sf.sort_order,
  sf.id;
