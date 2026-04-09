INSERT INTO lead_statuses (code, label, description, sort_order, is_active)
VALUES
  ('draft', 'Borrador', 'Lead detectado pero aun no calificado.', 10, TRUE),
  ('qualified_partial', 'Calificado Parcial', 'Lead con intencion real pero informacion incompleta.', 20, TRUE),
  ('qualified_complete', 'Calificado Completo', 'Lead con informacion suficiente para gestion comercial.', 30, TRUE),
  ('created_in_clickup', 'Creado en ClickUp', 'Lead ya creado como tarea en ClickUp.', 40, TRUE),
  ('assigned', 'Asignado', 'Lead asignado a un vendedor.', 50, TRUE),
  ('notified', 'Notificado', 'Lead asignado y vendedor notificado.', 60, TRUE),
  ('closed', 'Cerrado', 'Lead cerrado operativamente.', 70, TRUE),
  ('error', 'Error', 'Lead con error de procesamiento o integracion.', 80, TRUE)
ON CONFLICT (code) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

