INSERT INTO conversation_statuses (code, label, description, sort_order, is_active)
VALUES
  ('active', 'Activa', 'Conversacion en curso dentro del flujo del bot.', 10, TRUE),
  ('waiting_user', 'Esperando Respuesta', 'El sistema espera respuesta del usuario.', 20, TRUE),
  ('out_of_flow', 'Fuera de Flujo', 'El usuario respondio fuera del paso esperado.', 30, TRUE),
  ('handed_to_sales', 'Derivada a Ventas', 'La conversacion fue derivada al equipo comercial.', 40, TRUE),
  ('inactive_timeout', 'Inactiva por Tiempo', 'La conversacion quedo inactiva por expiracion operativa.', 50, TRUE),
  ('closed', 'Cerrada', 'La conversacion se cerro operativamente.', 60, TRUE),
  ('error', 'Error', 'La conversacion encontro un error de proceso o integracion.', 70, TRUE)
ON CONFLICT (code) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

