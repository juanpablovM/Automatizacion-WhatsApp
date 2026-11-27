-- CRM 1.3 (U6, S8): one ownership counter per contact.
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (S8). Contract:
-- .orca/drops/whatsapp-events-1.3-crm-response.md §4.4: under 1.3,
-- ownership.taken / ownership.released carry the customer's version, one
-- counter per contact_id, started above the highest per-conversation version
-- ever sent for any of its conversations, so no 1.3 event is stale against a
-- 1.2 one.
--
-- 1. crm_contacts.ownership_version (BIGINT, >= 0, default 0).
-- 2. crm_ownership_changes.contact_id / contact_version: the contact whose
--    counter the change advanced and its value. NULL on rows from before this
--    migration (those are never sent under 1.3) and when the conversation has
--    no contact (no source number). Unique per contact.
-- 3. crm_track_lead_chat_ownership() (last defined in 047): unchanged for the
--    conversation (crm_conversation_ownership, ownership_version: 1.2 and the
--    inbound responses read it). In the same subtransaction it then resolves
--    the conversation's contact (crm_contact_ensure, 053, from its source
--    number + phone) and advances the contact's counter under the row lock of
--    the UPDATE: new value = GREATEST(current counter, highest version of the
--    contact's other conversations, this conversation's previous version) + 1,
--    so it is always above every per-conversation version, also for a contact
--    created after its conversations already had versions. Lock order stays
--    crm_conversation_ownership -> crm_contacts (the inbound functions lock
--    the conversation row first). A failure resolving the contact never
--    loses the per-conversation change: the change is stored without contact.
-- 4. Seed: crm_contacts_seed_ownership_version() puts each contact at
--    GREATEST(its counter, max per-conversation version of its conversations);
--    it never lowers a counter. Runs after the function is replaced; the
--    ALTER TABLE on crm_ownership_changes holds its lock to COMMIT, so a
--    change committed before is in the seed and one after uses the new body.
--
-- Down migration: infra/postgres/rollback/056_crm_contact_ownership_version.down.sql
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1-2. Columns
-- -----------------------------------------------------------------------------
ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS ownership_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS chk_crm_contacts_ownership_version;
ALTER TABLE crm_contacts ADD CONSTRAINT chk_crm_contacts_ownership_version CHECK (ownership_version >= 0);

ALTER TABLE crm_ownership_changes
  ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES crm_contacts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS contact_version BIGINT;
ALTER TABLE crm_ownership_changes DROP CONSTRAINT IF EXISTS chk_crm_ownership_changes_contact;
ALTER TABLE crm_ownership_changes ADD CONSTRAINT chk_crm_ownership_changes_contact CHECK (
  (contact_id IS NULL AND contact_version IS NULL)
  OR (contact_id IS NOT NULL AND contact_version IS NOT NULL AND contact_version >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_ownership_changes_contact_version
ON crm_ownership_changes (contact_id, contact_version)
WHERE contact_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Version tracking (047) + the contact counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_track_lead_chat_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_conversation BIGINT;
  v_kind TEXT;
  v_source TEXT;
  v_reason TEXT;
  v_seller BIGINT;
  v_version BIGINT;
  v_source_number BIGINT;
  v_phone TEXT;
  v_contact BIGINT;
  v_contact_version BIGINT;
BEGIN
  BEGIN
    v_conversation := COALESCE(NEW.conversation_id, crm_lead_conversation_id(NEW.lead_id));
    IF v_conversation IS NULL THEN
      RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
      v_kind := 'taken';
      v_reason := NULL;
      v_source := CASE WHEN NEW.acquired_via = 'crm' THEN 'crm' ELSE 'clickup' END;
      v_seller := COALESCE(
        NEW.owner_seller_id,
        (SELECT l.assigned_seller_id FROM leads l WHERE l.id = NEW.lead_id)
      );
    ELSE
      v_kind := 'released';
      v_reason := CASE NEW.release_reason
        WHEN 'sla_expired' THEN 'sla_expired'
        WHEN 'customer_new_quote' THEN 'customer_new_quote'
        ELSE 'seller_released'
      END;
      v_source := CASE
        WHEN NEW.released_via = 'crm' THEN 'crm'
        WHEN NEW.release_reason = 'clickup_released' THEN 'clickup'
        ELSE 'bot'
      END;
      v_seller := NULL;
    END IF;

    INSERT INTO crm_conversation_ownership AS cco (
      conversation_id, ownership_version, owner_kind, seller_id, source, reason,
      lead_id, ownership_id, changed_at
    ) VALUES (
      v_conversation, 1, CASE WHEN v_kind = 'taken' THEN 'seller' ELSE 'bot' END,
      v_seller, v_source, v_reason, NEW.lead_id, NEW.id, NOW()
    )
    ON CONFLICT (conversation_id) DO UPDATE SET
      ownership_version = cco.ownership_version + 1,
      owner_kind = EXCLUDED.owner_kind,
      seller_id = EXCLUDED.seller_id,
      source = EXCLUDED.source,
      reason = EXCLUDED.reason,
      lead_id = EXCLUDED.lead_id,
      ownership_id = EXCLUDED.ownership_id,
      changed_at = EXCLUDED.changed_at
    RETURNING cco.ownership_version INTO v_version;

    -- 056: the contact counter. Its own subtransaction, so a failure here
    -- keeps the per-conversation change (stored without a contact).
    BEGIN
      SELECT c.source_number_id, c.phone_number INTO v_source_number, v_phone
      FROM conversations c
      WHERE c.id = v_conversation;
      v_contact := crm_contact_ensure(v_source_number, v_phone);
      IF v_contact IS NOT NULL THEN
        UPDATE crm_contacts ct
        SET ownership_version = GREATEST(
          ct.ownership_version,
          v_version - 1,
          COALESCE((
            SELECT MAX(cco.ownership_version)
            FROM conversations oc
            JOIN crm_conversation_ownership cco ON cco.conversation_id = oc.id
            WHERE oc.source_number_id = v_source_number
              AND oc.phone_number = v_phone
              AND oc.id <> v_conversation
          ), 0)
        ) + 1
        WHERE ct.id = v_contact
        RETURNING ct.ownership_version INTO v_contact_version;
        IF v_contact_version IS NULL THEN
          v_contact := NULL;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'crm contact ownership counter skipped for lead_chat_ownerships id %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
      v_contact := NULL;
      v_contact_version := NULL;
    END;

    INSERT INTO crm_ownership_changes (
      conversation_id, ownership_version, change_kind, lead_id, ownership_id,
      seller_id, source, reason, raw_reason, contact_id, contact_version
    ) VALUES (
      v_conversation, v_version, v_kind, NEW.lead_id, NEW.id,
      v_seller, v_source, v_reason,
      CASE WHEN v_kind = 'released' THEN NEW.release_reason END,
      v_contact, CASE WHEN v_contact IS NOT NULL THEN v_contact_version END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'crm ownership tracking skipped for lead_chat_ownerships id %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Seed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_contacts_seed_ownership_version()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE crm_contacts ct
  SET ownership_version = m.max_version
  FROM (
    SELECT c.source_number_id, c.phone_number, MAX(cco.ownership_version) AS max_version
    FROM conversations c
    JOIN crm_conversation_ownership cco ON cco.conversation_id = c.id
    WHERE c.source_number_id IS NOT NULL
      AND c.phone_number IS NOT NULL
    GROUP BY c.source_number_id, c.phone_number
  ) m
  WHERE ct.source_number_id = m.source_number_id
    AND ct.phone_number = m.phone_number
    AND ct.ownership_version < GREATEST(0, m.max_version);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

SELECT crm_contacts_seed_ownership_version();

COMMIT;
