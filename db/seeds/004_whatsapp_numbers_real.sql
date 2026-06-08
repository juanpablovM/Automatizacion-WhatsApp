-- Seed: Número de WhatsApp real de Hormiglass
-- Basado en información de Evolution API - instancia wahormiglass
-- ownerJid: 56972328559@s.whatsapp.net

INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, business_account_id, is_active)
VALUES ('Hormiglass Principal', '56972328559', '56972328559', NULL, true)
ON CONFLICT (phone_number) WHERE deleted_at IS NULL
DO UPDATE SET 
    display_name = EXCLUDED.display_name,
    phone_number_id = EXCLUDED.phone_number_id,
    is_active = EXCLUDED.is_active,
    deleted_at = NULL;