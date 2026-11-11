-- CRM outbox for contract revision 1.2: message.new events and record-based
-- lead.qualified corrections.
--
-- * crm_events now holds two event types. lead.qualified rows keep lead_id;
--   message.new rows carry message_id instead (lead_id NULL, revision 1). A
--   CHECK enforces which identity each type needs, and (message_id, event_type)
--   is unique so a message is enqueued once.
-- * The immutability trigger also covers the new identity columns.
-- * crm_message_blocks records why a message is not enqueued yet (e.g. a seller
--   reply whose seller has no crm_user_id). The row disappears once the
--   message is enqueued.
-- * Under 1.2 a correction is any change in the lead record the CRM receives,
--   not only in the requirement. crm_lead_source_hash() fingerprints the raw
--   inputs of that record so the dispatcher only rebuilds leads whose inputs
--   changed; the builder then compares the hash of the business fields it would
--   send (crm_enqueued_record_hash) and enqueues a new revision only when that
--   differs. AI-summary churn is not an input and never creates a revision.
-- Additive: the ClickUp path ignores every object added here, and revision 1.1
-- keeps its requirement rule.

ALTER TABLE crm_events
  ALTER COLUMN lead_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS message_id BIGINT REFERENCES messages(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_identity_check') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
      (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
      AND (event_type <> 'message.new' OR message_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_message_type_key') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_message_type_key UNIQUE (message_id, event_type);
  END IF;
END
$$;

-- The message stage gates on delivered lead.qualified events per conversation.
CREATE INDEX IF NOT EXISTS idx_crm_events_lead_conversation
ON crm_events (conversation_id)
WHERE event_type = 'lead.qualified' AND status = 'delivered';

-- The body and every identity column are immutable: a retry must resend the
-- exact bytes under the same identity.
CREATE OR REPLACE FUNCTION crm_events_body_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id
     OR NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, event_type, revision, lead_id and message_id never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS crm_message_blocks (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- crm_enqueued_record_hash: sha256 of the business fields of the newest
-- enqueued 1.2 lead.qualified body. crm_checked_source_hash: the
-- crm_lead_source_hash() value the dispatcher last examined.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS crm_enqueued_record_hash TEXT,
  ADD COLUMN IF NOT EXISTS crm_checked_source_hash TEXT;

-- Fingerprint of every raw input of the 1.2 lead record except the AI summary:
-- lead columns, qualification context, conversation, seller mapping and the
-- source number. A change here only means "rebuild and compare".
CREATE OR REPLACE FUNCTION crm_lead_source_hash(p_lead_id BIGINT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT md5(jsonb_build_array(
    l.phone_number,
    l.whatsapp_name,
    l.service,
    l.city,
    l.requirement,
    l.qualification_context,
    l.source_conversation_id,
    (
      SELECT c.id
      FROM conversations c
      WHERE c.lead_id = l.id
        AND c.deleted_at IS NULL
      ORDER BY c.id DESC
      LIMIT 1
    ),
    s.crm_user_id,
    wn.phone_number
  )::text)
  FROM leads l
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id
  LEFT JOIN whatsapp_numbers wn ON wn.id = l.source_number_id
  WHERE l.id = p_lead_id
$$;
