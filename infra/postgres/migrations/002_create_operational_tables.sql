CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  business_account_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sellers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp_number TEXT,
  clickup_user_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL,
  last_assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assignment_rotations (
  id BIGSERIAL PRIMARY KEY,
  rotation_key TEXT NOT NULL UNIQUE,
  last_seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  next_seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  last_assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  previous_lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  external_contact_id TEXT,
  whatsapp_name TEXT,
  phone_number TEXT NOT NULL,
  service TEXT,
  city TEXT,
  requirement TEXT,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  lead_status_id BIGINT NOT NULL REFERENCES lead_statuses(id),
  assigned_seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  clickup_task_id TEXT,
  clickup_task_url TEXT,
  is_qualified BOOLEAN NOT NULL DEFAULT FALSE,
  is_partial BOOLEAN NOT NULL DEFAULT FALSE,
  qualified_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  conversation_status_id BIGINT NOT NULL REFERENCES conversation_statuses(id),
  current_step TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handed_to_sales_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL CHECK (
    message_type IN ('text', 'image', 'audio', 'document', 'video', 'location', 'interactive', 'unknown')
  ),
  external_message_id TEXT,
  external_timestamp TIMESTAMPTZ,
  delivery_status TEXT,
  text_body TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_type TEXT NOT NULL,
  mime_type TEXT,
  filename TEXT,
  external_media_id TEXT,
  external_url TEXT,
  sha256 TEXT,
  file_size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lead_assignments (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('automatic', 'manual', 'reassignment')),
  assignment_result TEXT NOT NULL CHECK (assignment_result IN ('assigned', 'skipped', 'failed')),
  reason TEXT,
  rotation_id BIGINT REFERENCES assignment_rotations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  result TEXT NOT NULL,
  before_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  after_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_whatsapp_numbers_updated_at ON whatsapp_numbers;

CREATE TRIGGER set_whatsapp_numbers_updated_at
BEFORE UPDATE ON whatsapp_numbers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_sellers_updated_at ON sellers;

CREATE TRIGGER set_sellers_updated_at
BEFORE UPDATE ON sellers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_assignment_rotations_updated_at ON assignment_rotations;

CREATE TRIGGER set_assignment_rotations_updated_at
BEFORE UPDATE ON assignment_rotations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_leads_updated_at ON leads;

CREATE TRIGGER set_leads_updated_at
BEFORE UPDATE ON leads
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_conversations_updated_at ON conversations;

CREATE TRIGGER set_conversations_updated_at
BEFORE UPDATE ON conversations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_messages_updated_at ON messages;

CREATE TRIGGER set_messages_updated_at
BEFORE UPDATE ON messages
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_message_attachments_updated_at ON message_attachments;

CREATE TRIGGER set_message_attachments_updated_at
BEFORE UPDATE ON message_attachments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
