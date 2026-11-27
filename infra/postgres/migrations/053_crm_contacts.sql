-- CRM 1.3: contact identity (one customer per WhatsApp line).
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (U1, S2).
--
-- 1. crm_contacts: one row per (source_number_id, phone_number), the de facto
--    customer key of conversations, leads and handoffs. Its id is the stable
--    contact id the CRM receives as `wa-<prefix>-contact-<id>` (built in JS).
--    A contact is never deleted by the bot. Later 1.3 migrations add the
--    upsert revision, the state version/hash, the per-contact ownership
--    counter and the linked opportunity.
--    whatsapp_numbers deletion cascades to its contacts so a line that never
--    reached the CRM can still be removed (test cleanups do it); once a
--    contact is referenced by a crm_events row (054) that event's RESTRICT
--    blocks the deletion.
-- 2. crm_contacts_seed(): creates the missing contacts from every distinct
--    non-NULL pair in conversations, leads and handoffs, earliest first
--    activity first, so ids are deterministic. Re-running it is a no-op.
-- 3. crm_track_contact(): AFTER INSERT (and AFTER UPDATE of the pair) on the
--    three tables, creates the pair's contact when it is missing. It NEVER
--    fails the write that fired it (same defensive pattern as 040).
-- 4. crm_contact_ref(source_number_id, phone): the contact id or NULL.
--
-- Additive: no existing row or behaviour changes. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. crm_contacts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_contacts (
  id BIGSERIAL PRIMARY KEY,
  source_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_contacts_source_phone_key UNIQUE (source_number_id, phone_number)
);

-- -----------------------------------------------------------------------------
-- 4. crm_contact_ref (defined before the seed and the trigger that reuse it)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_contact_ref(p_source_number_id BIGINT, p_phone TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT c.id
  FROM crm_contacts c
  WHERE c.source_number_id = p_source_number_id
    AND c.phone_number = p_phone
$$;

-- -----------------------------------------------------------------------------
-- 2. Seed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_contacts_seed()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted BIGINT;
BEGIN
  WITH activity AS (
    SELECT source_number_id, phone_number, created_at FROM conversations
    UNION ALL
    SELECT source_number_id, phone_number, created_at FROM leads
    UNION ALL
    SELECT source_number_id, phone_number, created_at FROM handoffs
  ),
  pairs AS (
    SELECT a.source_number_id, a.phone_number, MIN(a.created_at) AS first_activity_at
    FROM activity a
    WHERE a.source_number_id IS NOT NULL
      AND a.phone_number IS NOT NULL
    GROUP BY a.source_number_id, a.phone_number
  ),
  inserted AS (
    INSERT INTO crm_contacts (source_number_id, phone_number)
    SELECT p.source_number_id, p.phone_number
    FROM pairs p
    WHERE NOT EXISTS (
      SELECT 1 FROM crm_contacts c
      WHERE c.source_number_id = p.source_number_id
        AND c.phone_number = p.phone_number
    )
    ORDER BY p.first_activity_at, p.source_number_id, p.phone_number
    ON CONFLICT (source_number_id, phone_number) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;
  RETURN v_inserted;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Keep it complete
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_track_contact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    IF NEW.source_number_id IS NOT NULL
       AND NEW.phone_number IS NOT NULL
       AND crm_contact_ref(NEW.source_number_id, NEW.phone_number) IS NULL THEN
      INSERT INTO crm_contacts (source_number_id, phone_number)
      VALUES (NEW.source_number_id, NEW.phone_number)
      ON CONFLICT (source_number_id, phone_number) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'crm contact tracking skipped for % id %: % (%)',
      TG_TABLE_NAME, NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_track_contact ON conversations;
CREATE TRIGGER trg_crm_track_contact
AFTER INSERT OR UPDATE OF source_number_id, phone_number ON conversations
FOR EACH ROW
WHEN (NEW.source_number_id IS NOT NULL)
EXECUTE FUNCTION crm_track_contact();

DROP TRIGGER IF EXISTS trg_crm_track_contact ON leads;
CREATE TRIGGER trg_crm_track_contact
AFTER INSERT OR UPDATE OF source_number_id, phone_number ON leads
FOR EACH ROW
WHEN (NEW.source_number_id IS NOT NULL)
EXECUTE FUNCTION crm_track_contact();

DROP TRIGGER IF EXISTS trg_crm_track_contact ON handoffs;
CREATE TRIGGER trg_crm_track_contact
AFTER INSERT OR UPDATE OF source_number_id, phone_number ON handoffs
FOR EACH ROW
WHEN (NEW.source_number_id IS NOT NULL)
EXECUTE FUNCTION crm_track_contact();

-- crm_contact_ensure(): the contact of a pair, created when missing. A trigger
-- whose work was skipped (lock timeout or deadlock victim while the other
-- writer rolled back) can leave a pair without a contact; every reader that
-- needs the contact id calls this instead of crm_contact_ref.
CREATE OR REPLACE FUNCTION crm_contact_ensure(p_source_number_id BIGINT, p_phone TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF p_source_number_id IS NULL OR p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  v_id := crm_contact_ref(p_source_number_id, p_phone);
  IF v_id IS NULL THEN
    INSERT INTO crm_contacts (source_number_id, phone_number)
    VALUES (p_source_number_id, p_phone)
    ON CONFLICT (source_number_id, phone_number) DO NOTHING;
    v_id := crm_contact_ref(p_source_number_id, p_phone);
  END IF;
  RETURN v_id;
END;
$$;

-- The seed runs after the triggers exist. CREATE TRIGGER holds a lock on each
-- table until COMMIT, so a bot write either committed before it (the seed
-- sees it) or waits and then fires the trigger: no write falls in a gap.
SELECT crm_contacts_seed();

COMMIT;
