-- Seed: Vendedores Reales de Hormiglass
-- Orden round robin: 1→Catherine, 2→Edith, 3→Lorena
-- Patricia Jorquera: pendiente clickup_user_id → inactiva hasta tenerlo

INSERT INTO sellers (name, whatsapp_number, clickup_user_id, is_active, sort_order)
VALUES
  ('Catherine Tamayo',   NULL, '89274684', true,  1),
  ('Edith Tapia',        NULL, '89115803', true,  2),
  ('Lorena Gutierrez',   NULL, '89269391', true,  3),
  ('Patricia Jorquera',  NULL, NULL,       false, 4);

-- Inicializar rotación round robin con Catherine como primera
INSERT INTO assignment_rotations (rotation_key, last_seller_id, next_seller_id)
VALUES ('default', NULL, (SELECT id FROM sellers WHERE is_active=true AND deleted_at IS NULL ORDER BY sort_order LIMIT 1));