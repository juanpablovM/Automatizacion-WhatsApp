-- Monitor: Active Conversations
--
-- Proposito:
--   Panel de control de conversaciones activas de WhatsApp.
--   Muestra conversaciones en curso, derivadas a ventas e inactivas/error
--   con contexto del lead y vendedor asignado.
--
-- Uso:
--   docker compose --env-file .env exec -T postgres \
--     psql -U postgres -d crm_whatsapp_app \
--     -f db/queries/ops/monitor-active-conversations.sql
--
-- Columnas de salida:
--   section            Categoria: 'active_waiting' | 'handed_to_sales' | 'inactive_error'
--   conversation_id    ID de la conversacion
--   status_label       Estado legible (ej. 'Activa', 'Esperando Respuesta')
--   phone_number       Numero del contacto
--   last_message_at    Timestamp del ultimo mensaje
--   idle_hours         Horas desde el ultimo mensaje (1 decimal)
--   message_count      Total de mensajes en la conversacion
--   lead_id            ID del lead asociado (NULL si no existe)
--   lead_status        Estado del lead (NULL si no existe)
--   lead_service       Servicio solicitado (NULL si no existe)
--   lead_city          Ciudad (NULL si no existe)
--   lead_requirement   Requerimiento (NULL si no existe)
--   seller_name        Vendedor asignado (NULL si no esta asignado)

WITH active_waiting AS (
  SELECT
    'active_waiting'::TEXT AS section,
    c.id AS conversation_id,
    cs.label AS status_label,
    c.phone_number,
    c.last_message_at,
    ROUND(EXTRACT(EPOCH FROM NOW() - c.last_message_at) / 3600, 1) AS idle_hours,
    COALESCE(msg_count.message_count, 0) AS message_count,
    l.id AS lead_id,
    ls.label AS lead_status,
    l.service AS lead_service,
    l.city AS lead_city,
    l.requirement AS lead_requirement,
    s.name AS seller_name
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
  LEFT JOIN lead_statuses ls ON ls.id = l.lead_status_id
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS message_count
    FROM messages m
    WHERE m.conversation_id = c.id
  ) msg_count ON TRUE
  WHERE c.deleted_at IS NULL
    AND cs.code IN ('active', 'waiting_user')
),
handed_to_sales AS (
  SELECT
    'handed_to_sales'::TEXT AS section,
    c.id AS conversation_id,
    cs.label AS status_label,
    c.phone_number,
    c.last_message_at,
    ROUND(EXTRACT(EPOCH FROM NOW() - c.last_message_at) / 3600, 1) AS idle_hours,
    COALESCE(msg_count.message_count, 0) AS message_count,
    l.id AS lead_id,
    ls.label AS lead_status,
    l.service AS lead_service,
    l.city AS lead_city,
    l.requirement AS lead_requirement,
    s.name AS seller_name
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
  LEFT JOIN lead_statuses ls ON ls.id = l.lead_status_id
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS message_count
    FROM messages m
    WHERE m.conversation_id = c.id
  ) msg_count ON TRUE
  WHERE c.deleted_at IS NULL
    AND cs.code = 'handed_to_sales'
),
inactive_error AS (
  SELECT
    'inactive_error'::TEXT AS section,
    c.id AS conversation_id,
    cs.label AS status_label,
    c.phone_number,
    c.last_message_at,
    ROUND(EXTRACT(EPOCH FROM NOW() - c.last_message_at) / 3600, 1) AS idle_hours,
    COALESCE(msg_count.message_count, 0) AS message_count,
    l.id AS lead_id,
    ls.label AS lead_status,
    l.service AS lead_service,
    l.city AS lead_city,
    l.requirement AS lead_requirement,
    s.name AS seller_name
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
  LEFT JOIN lead_statuses ls ON ls.id = l.lead_status_id
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id AND s.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS message_count
    FROM messages m
    WHERE m.conversation_id = c.id
  ) msg_count ON TRUE
  WHERE c.deleted_at IS NULL
    AND cs.code IN ('inactive_timeout', 'error')
)
SELECT * FROM active_waiting
UNION ALL
SELECT * FROM handed_to_sales
UNION ALL
SELECT * FROM inactive_error
ORDER BY section, idle_hours DESC;
