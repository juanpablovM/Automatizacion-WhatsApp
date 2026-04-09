CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_numbers_phone_number
ON whatsapp_numbers (phone_number)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_numbers_phone_number_id
ON whatsapp_numbers (phone_number_id)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sellers_sort_order
ON sellers (sort_order)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sellers_whatsapp_number
ON sellers (whatsapp_number)
WHERE whatsapp_number IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sellers_clickup_user_id
ON sellers (clickup_user_id)
WHERE clickup_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_external_message_id
ON messages (external_message_id)
WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_phone_number
ON leads (phone_number);

CREATE INDEX IF NOT EXISTS idx_leads_previous_lead_id
ON leads (previous_lead_id);

CREATE INDEX IF NOT EXISTS idx_leads_status_id
ON leads (lead_status_id);

CREATE INDEX IF NOT EXISTS idx_leads_assigned_seller_id
ON leads (assigned_seller_id);

CREATE INDEX IF NOT EXISTS idx_leads_source_number_id
ON leads (source_number_id);

CREATE INDEX IF NOT EXISTS idx_conversations_phone_number
ON conversations (phone_number);

CREATE INDEX IF NOT EXISTS idx_conversations_lead_id
ON conversations (lead_id);

CREATE INDEX IF NOT EXISTS idx_conversations_status_id
ON conversations (conversation_status_id);

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
ON conversations (last_message_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
ON messages (conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_lead_id
ON messages (lead_id);

CREATE INDEX IF NOT EXISTS idx_messages_external_timestamp
ON messages (external_timestamp);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
ON message_attachments (message_id);

CREATE INDEX IF NOT EXISTS idx_lead_assignments_lead_id
ON lead_assignments (lead_id);

CREATE INDEX IF NOT EXISTS idx_lead_assignments_seller_id
ON lead_assignments (seller_id);

CREATE INDEX IF NOT EXISTS idx_lead_assignments_rotation_id
ON lead_assignments (rotation_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
ON audit_logs (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_name
ON audit_logs (event_name);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
ON audit_logs (created_at);

