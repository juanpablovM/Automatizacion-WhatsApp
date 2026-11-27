-- Rollback of migration 056 (per-contact ownership counter).
-- First re-import a crm-events-dispatcher whose ownership select does not read
-- crm_ownership_changes.contact_id / contact_version (pre-056), or switch the
-- dispatcher back to revision 1.2: under 1.3 the 056 select reads them.
-- crm_track_lead_chat_ownership() is restored verbatim from 047, so takes and
-- releases advance only the conversation's version again. The contact
-- counters and the contact columns of crm_ownership_changes are dropped;
-- 1.3 ownership events already in crm_events stay (their bodies are frozen).
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Verbatim from migration 047.
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

    INSERT INTO crm_ownership_changes (
      conversation_id, ownership_version, change_kind, lead_id, ownership_id,
      seller_id, source, reason, raw_reason
    ) VALUES (
      v_conversation, v_version, v_kind, NEW.lead_id, NEW.id,
      v_seller, v_source, v_reason,
      CASE WHEN v_kind = 'released' THEN NEW.release_reason END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'crm ownership tracking skipped for lead_chat_ownerships id %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS crm_contacts_seed_ownership_version();

DROP INDEX IF EXISTS uq_crm_ownership_changes_contact_version;
ALTER TABLE crm_ownership_changes DROP CONSTRAINT IF EXISTS chk_crm_ownership_changes_contact;
ALTER TABLE crm_ownership_changes
  DROP COLUMN IF EXISTS contact_version,
  DROP COLUMN IF EXISTS contact_id;

ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS chk_crm_contacts_ownership_version;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS ownership_version;

COMMIT;
