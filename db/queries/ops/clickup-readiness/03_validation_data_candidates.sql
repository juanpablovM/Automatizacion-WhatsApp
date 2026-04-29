-- Auditoria read-only de leads/tareas que podrian ser datos de validacion.
--
-- El esquema actual no tiene un campo formal de ambiente o etiqueta de prueba.
-- Esta query usa heuristicas para revisar candidatos antes de excluirlos de
-- reportes comerciales o marcarlos manualmente en ClickUp.

WITH validation_signals AS (
  SELECT
    l.id AS lead_id,
    l.created_at,
    l.updated_at,
    l.whatsapp_name,
    l.phone_number,
    l.service,
    l.city,
    l.requirement,
    ls.code AS lead_status,
    l.clickup_task_id,
    l.clickup_task_url,
    s.name AS seller_name,
    s.clickup_user_id,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN l.id IN (14, 15, 16, 20, 22, 24) THEN 'documented_validation_lead_id' END,
      CASE WHEN COALESCE(l.clickup_task_id, '') IN ('86agtc6z3', '86ah3h2ew', '86ah3h2m6', '86ah3h2q6', '86ah3nq8a', '86ah3ntj1', '86ah3pba6') THEN 'documented_validation_clickup_task' END,
      CASE WHEN l.phone_number ~ '^(5690000|5691111|5691234|5699999)' THEN 'synthetic_phone_pattern' END,
      CASE WHEN CONCAT_WS(' ', l.whatsapp_name, l.service, l.city, l.requirement) ~* '(test|prueba|demo|qa|smoke|validacion|validación)' THEN 'test_keyword' END
    ], NULL) AS validation_reasons
  FROM leads l
  JOIN lead_statuses ls ON ls.id = l.lead_status_id
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id
  WHERE l.deleted_at IS NULL
)
SELECT
  lead_id,
  created_at,
  whatsapp_name,
  phone_number,
  service,
  city,
  requirement,
  lead_status,
  clickup_task_id,
  clickup_task_url,
  seller_name,
  clickup_user_id,
  validation_reasons
FROM validation_signals
WHERE CARDINALITY(validation_reasons) > 0
ORDER BY created_at DESC, lead_id DESC;
