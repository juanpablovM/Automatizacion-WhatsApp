-- Plantilla read-only para metricas operativas sin datos de validacion conocidos.
--
-- Criterio actual:
-- - excluir leads/tareas documentados como pruebas reales o sinteticas
-- - excluir telefonos sinteticos obvios
-- - excluir textos con marcadores de prueba
--
-- Pendiente recomendado antes de produccion:
-- - agregar una marca formal de ambiente/validacion en el modelo o en una tabla
--   auxiliar para no depender de heuristicas.

WITH validation_leads AS (
  SELECT l.id
  FROM leads l
  WHERE l.id IN (14, 15, 16, 20, 22, 24)
    OR COALESCE(l.clickup_task_id, '') IN ('86agtc6z3', '86ah3h2ew', '86ah3h2m6', '86ah3h2q6', '86ah3nq8a', '86ah3ntj1', '86ah3pba6')
    OR l.phone_number ~ '^(5690000|5691111|5691234|5699999)'
    OR CONCAT_WS(' ', l.whatsapp_name, l.service, l.city, l.requirement) ~* '(test|prueba|demo|qa|smoke|validacion|validación)'
),
commercial_leads AS (
  SELECT
    l.id,
    l.created_at,
    ls.code AS lead_status,
    s.id AS seller_id,
    s.name AS seller_name,
    l.clickup_task_id
  FROM leads l
  JOIN lead_statuses ls ON ls.id = l.lead_status_id
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id
  WHERE l.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM validation_leads vl
      WHERE vl.id = l.id
    )
)
SELECT
  DATE_TRUNC('day', created_at)::date AS lead_date,
  lead_status,
  seller_id,
  COALESCE(seller_name, 'Sin vendedor') AS seller_name,
  COUNT(*) AS leads_count,
  COUNT(*) FILTER (WHERE clickup_task_id IS NOT NULL) AS clickup_tasks_count
FROM commercial_leads
GROUP BY
  DATE_TRUNC('day', created_at)::date,
  lead_status,
  seller_id,
  COALESCE(seller_name, 'Sin vendedor')
ORDER BY lead_date DESC, lead_status, seller_name;
