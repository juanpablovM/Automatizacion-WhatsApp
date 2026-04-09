-- Inputs esperados:
-- :phone_number

SELECT
  l.id,
  l.previous_lead_id,
  l.source_number_id,
  l.external_contact_id,
  l.whatsapp_name,
  l.phone_number,
  l.service,
  l.city,
  l.requirement,
  l.channel,
  l.clickup_task_id,
  l.clickup_task_url,
  ls.code AS lead_status_code,
  l.created_at
FROM leads l
JOIN lead_statuses ls ON ls.id = l.lead_status_id
WHERE l.deleted_at IS NULL
  AND l.phone_number = :phone_number
ORDER BY l.created_at DESC
LIMIT 1;

