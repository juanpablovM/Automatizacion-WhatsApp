CREATE TABLE IF NOT EXISTS catalog_categories (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id BIGSERIAL PRIMARY KEY,
  category_id BIGINT REFERENCES catalog_categories(id) ON DELETE SET NULL,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'product'
    CHECK (item_type IN ('product', 'service', 'bundle', 'other')),
  short_description TEXT,
  long_description TEXT,
  service_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  applicable_cities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  restrictions JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS catalog_item_media (
  id BIGSERIAL PRIMARY KEY,
  catalog_item_id BIGINT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'document', 'link')),
  url TEXT NOT NULL,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS commercial_conditions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  condition_type TEXT NOT NULL CHECK (
    condition_type IN (
      'payment',
      'warranty',
      'delivery',
      'installation',
      'returns',
      'quote',
      'discount',
      'general'
    )
  ),
  body TEXT NOT NULL,
  applies_to JSONB NOT NULL DEFAULT '{}'::JSONB,
  effective_from DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS price_rules (
  id BIGSERIAL PRIMARY KEY,
  catalog_item_id BIGINT REFERENCES catalog_items(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  price_type TEXT NOT NULL CHECK (
    price_type IN ('fixed', 'from', 'range', 'formula', 'requires_human')
  ),
  currency TEXT NOT NULL DEFAULT 'CLP',
  amount NUMERIC(14, 2),
  amount_min NUMERIC(14, 2),
  amount_max NUMERIC(14, 2),
  unit TEXT,
  formula JSONB NOT NULL DEFAULT '{}'::JSONB,
  conditions JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_reference BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (amount IS NULL OR amount >= 0),
  CHECK (amount_min IS NULL OR amount_min >= 0),
  CHECK (amount_max IS NULL OR amount_max >= 0),
  CHECK (amount_max IS NULL OR amount_min IS NULL OR amount_max >= amount_min),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (
    (price_type IN ('fixed', 'from') AND amount IS NOT NULL)
    OR (price_type = 'range' AND amount_min IS NOT NULL AND amount_max IS NOT NULL)
    OR (price_type = 'formula' AND formula <> '{}'::JSONB)
    OR price_type = 'requires_human'
  )
);

CREATE TABLE IF NOT EXISTS faq_entries (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  applies_to JSONB NOT NULL DEFAULT '{}'::JSONB,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS objection_playbooks (
  id BIGSERIAL PRIMARY KEY,
  objection_type TEXT NOT NULL,
  customer_signal TEXT NOT NULL,
  recommended_response TEXT NOT NULL,
  escalation_rule TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS appointment_slots (
  id BIGSERIAL PRIMARY KEY,
  slot_type TEXT NOT NULL CHECK (
    slot_type IN ('call', 'visit', 'measurement', 'pickup', 'delivery', 'other')
  ),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Santiago',
  city TEXT,
  capacity INTEGER NOT NULL DEFAULT 1,
  booked_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'held', 'booked', 'cancelled', 'unavailable')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (ends_at > starts_at),
  CHECK (capacity > 0),
  CHECK (booked_count >= 0),
  CHECK (booked_count <= capacity)
);

CREATE TABLE IF NOT EXISTS appointment_bookings (
  id BIGSERIAL PRIMARY KEY,
  appointment_slot_id BIGINT REFERENCES appointment_slots(id) ON DELETE SET NULL,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  customer_name TEXT,
  booking_status TEXT NOT NULL DEFAULT 'requested'
    CHECK (booking_status IN ('requested', 'held', 'confirmed', 'cancelled', 'no_show')),
  confirmation_source TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS quote_drafts (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  quote_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (quote_status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'void')),
  currency TEXT NOT NULL DEFAULT 'CLP',
  amount_min NUMERIC(14, 2),
  amount_max NUMERIC(14, 2),
  amount_total NUMERIC(14, 2),
  price_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  assumptions TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (amount_min IS NULL OR amount_min >= 0),
  CHECK (amount_max IS NULL OR amount_max >= 0),
  CHECK (amount_total IS NULL OR amount_total >= 0),
  CHECK (amount_max IS NULL OR amount_min IS NULL OR amount_max >= amount_min)
);

CREATE TABLE IF NOT EXISTS advisor_decisions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  decision_type TEXT NOT NULL,
  sales_stage TEXT,
  buying_intent TEXT CHECK (buying_intent IS NULL OR buying_intent IN ('low', 'medium', 'high')),
  urgency TEXT CHECK (urgency IS NULL OR urgency IN ('low', 'medium', 'high')),
  next_best_action TEXT,
  confidence NUMERIC(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  ai_provider TEXT,
  ai_model TEXT,
  input_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  output_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  validation_result TEXT NOT NULL DEFAULT 'accepted'
    CHECK (validation_result IN ('accepted', 'rejected', 'fallback', 'error')),
  validation_errors JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_catalog_categories_updated_at ON catalog_categories;

CREATE TRIGGER set_catalog_categories_updated_at
BEFORE UPDATE ON catalog_categories
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_catalog_items_updated_at ON catalog_items;

CREATE TRIGGER set_catalog_items_updated_at
BEFORE UPDATE ON catalog_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_catalog_item_media_updated_at ON catalog_item_media;

CREATE TRIGGER set_catalog_item_media_updated_at
BEFORE UPDATE ON catalog_item_media
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_commercial_conditions_updated_at ON commercial_conditions;

CREATE TRIGGER set_commercial_conditions_updated_at
BEFORE UPDATE ON commercial_conditions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_price_rules_updated_at ON price_rules;

CREATE TRIGGER set_price_rules_updated_at
BEFORE UPDATE ON price_rules
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_faq_entries_updated_at ON faq_entries;

CREATE TRIGGER set_faq_entries_updated_at
BEFORE UPDATE ON faq_entries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_objection_playbooks_updated_at ON objection_playbooks;

CREATE TRIGGER set_objection_playbooks_updated_at
BEFORE UPDATE ON objection_playbooks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_appointment_slots_updated_at ON appointment_slots;

CREATE TRIGGER set_appointment_slots_updated_at
BEFORE UPDATE ON appointment_slots
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_appointment_bookings_updated_at ON appointment_bookings;

CREATE TRIGGER set_appointment_bookings_updated_at
BEFORE UPDATE ON appointment_bookings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_quote_drafts_updated_at ON quote_drafts;

CREATE TRIGGER set_quote_drafts_updated_at
BEFORE UPDATE ON quote_drafts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_catalog_categories_active
ON catalog_categories (is_active, sort_order)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_items_category_id
ON catalog_items (category_id);

CREATE INDEX IF NOT EXISTS idx_catalog_items_active
ON catalog_items (is_active, item_type)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_items_service_keywords
ON catalog_items USING GIN (service_keywords);

CREATE INDEX IF NOT EXISTS idx_catalog_items_applicable_cities
ON catalog_items USING GIN (applicable_cities);

CREATE INDEX IF NOT EXISTS idx_catalog_item_media_item_id
ON catalog_item_media (catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_commercial_conditions_active
ON commercial_conditions (is_active, condition_type)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_price_rules_catalog_item_id
ON price_rules (catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_price_rules_active
ON price_rules (is_active, price_type)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_faq_entries_active_priority
ON faq_entries (is_active, priority DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_faq_entries_tags
ON faq_entries USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_objection_playbooks_type
ON objection_playbooks (objection_type, priority DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointment_slots_available
ON appointment_slots (starts_at, status, city)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointment_bookings_slot_id
ON appointment_bookings (appointment_slot_id);

CREATE INDEX IF NOT EXISTS idx_appointment_bookings_lead_id
ON appointment_bookings (lead_id);

CREATE INDEX IF NOT EXISTS idx_quote_drafts_conversation_id
ON quote_drafts (conversation_id);

CREATE INDEX IF NOT EXISTS idx_quote_drafts_lead_id
ON quote_drafts (lead_id);

CREATE INDEX IF NOT EXISTS idx_advisor_decisions_conversation_id
ON advisor_decisions (conversation_id);

CREATE INDEX IF NOT EXISTS idx_advisor_decisions_lead_id
ON advisor_decisions (lead_id);

CREATE INDEX IF NOT EXISTS idx_advisor_decisions_created_at
ON advisor_decisions (created_at);
