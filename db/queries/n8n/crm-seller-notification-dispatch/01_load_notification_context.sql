-- Inputs esperados:
-- :lead_id

SELECT
  l.id AS lead_id,
  l.whatsapp_name,
  l.phone_number,
  l.service,
  l.city,
  l.requirement,
  l.clickup_task_id,
  l.clickup_task_url,
  s.id AS seller_id,
  s.name AS seller_name,
  s.whatsapp_number AS seller_whatsapp_number,
  s.clickup_user_id
FROM leads l
JOIN sellers s ON s.id = l.assigned_seller_id
WHERE l.id = :lead_id
  AND l.deleted_at IS NULL;

