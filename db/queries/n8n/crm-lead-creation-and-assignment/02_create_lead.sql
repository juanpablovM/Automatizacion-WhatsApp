-- Inputs esperados:
-- :previous_lead_id (nullable)
-- :source_number_id (nullable)
-- :external_contact_id (nullable)
-- :whatsapp_name (nullable)
-- :phone_number
-- :service (nullable)
-- :city (nullable)
-- :requirement (nullable)
-- :lead_status_code
-- :is_qualified
-- :is_partial

INSERT INTO leads (
  previous_lead_id,
  source_number_id,
  external_contact_id,
  whatsapp_name,
  phone_number,
  service,
  city,
  requirement,
  channel,
  lead_status_id,
  is_qualified,
  is_partial,
  qualified_at
)
SELECT
  :previous_lead_id,
  :source_number_id,
  :external_contact_id,
  :whatsapp_name,
  :phone_number,
  :service,
  :city,
  :requirement,
  'whatsapp',
  ls.id,
  :is_qualified,
  :is_partial,
  CASE WHEN :is_qualified THEN NOW() ELSE NULL END
FROM lead_statuses ls
WHERE ls.code = :lead_status_code
RETURNING *;

