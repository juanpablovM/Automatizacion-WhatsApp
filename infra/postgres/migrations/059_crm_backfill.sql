-- CRM 1.3 (U8, S9, S11): the one-time backfill to the CRM production receiver.
--
-- Feature document: odd/tasks/crm-1-3-customer-threads.md (S9, S11; also S2-S5,
-- S8, S10). Contract: .orca/drops/whatsapp-events-1.3-crm-response.md §5 and
-- .orca/drops/whatsapp-events-1.3-crm-closed-history.md §2.
--
-- The backfill is not a second sender. An operator starts it once per id
-- prefix (scripts/ops/crm-backfill-1-3.sh --apply -> crm_backfill_start); the
-- dispatcher's backfill stage (select 15, Build Backfill Events, insert 16)
-- then enqueues each pending contact's history into crm_events, step by step,
-- and the normal delivery stage sends it (claim, deliver, complete, HMAC,
-- retries). Per contact, each step starts only once every earlier event of
-- that contact under the prefix left pending/processing (delivered or parked):
--   1. contact.upserted (the contact stage, 11/12);
--   2. lead.qualified (historical, outcome, closed_at) and resolved
--      handoff.created (historical, resolved_at, no routing key), oldest first;
--   3. open handoff.created (historical, live: routed as 1.2d, so it carries
--      the opportunity the CRM returned for the customer's open lead in step 2);
--   4. message.new (historical) in sent_at order, in batches;
--   5. the current chat holder as ownership.taken with the next contact
--      counter, when a seller lease is live (pre-056 changes are never sent
--      under 1.3, so the holder at the switch is sent explicitly);
--   6. the contact is marked completed; the contact.state stage (13/14) then
--      sends its current state, which is therefore last.
-- History is what existed at the run's cutoff (created_at <= cutoff_at);
-- anything later is live. While a contact is pending, the live stages (01, 05,
-- 07, 09, 13) send nothing for it, so no live event overtakes its history.
--
-- 1. crm_backfill_runs: one row per id prefix (the cutoff and the scope used).
-- 2. crm_contact_backfills: one row per contact in scope: pending (waits for
--    its backfill), completed, or skipped (a test phone: never backfilled,
--    never waits). previous_crm_ids archives the CRM ids the contact's rows
--    held from an earlier prefix (see 5).
-- 3. crm_backfill_blocks: history items the builders blocked (for example a
--    lead without a mapped seller), so a step can finish; the operator sees
--    them in the monitoring queries.
-- 4. crm_contact_backfill_pending(contact, prefix): the wait rule of the live
--    stages (NULL prefix = any prefix, for the stages without a prefix
--    parameter). crm_backfill_lead_outcome(): the S11 outcome rule.
-- 5. Prefix scoping. The per-lead CRM ids (leads.crm_customer_id /
--    crm_opportunity_id), the routing of open handoffs to an opportunity
--    (handoffs.crm_opportunity_id) and the contact's linked opportunity
--    (crm_contacts.crm_opportunity_*, 058) are not keyed by prefix; under a
--    new prefix the CRM dev values would be used for production routing (a
--    handoff routed to a dev opportunity, a lead.qualified attached to it).
--    crm_backfill_start archives them in crm_contact_backfills.previous_crm_ids
--    and clears them for every contact in scope; the production responses
--    then fill them again (04). crm_backfill_abandon restores them. The other
--    unscoped reads stay as they are: the delivered-handoff checks of
--    046/052 only matter for handoff ids the production CRM knows (it learns
--    them only from this prefix), 047/050/058 compare the full prefixed
--    conversation id, and the dispatcher's own reads that the backfill needs
--    are scoped in 15/16.
--
-- Down migration: infra/postgres/rollback/059_crm_backfill.down.sql (re-import
-- the pre-059 dispatcher workflow first: 01, 05, 07, 09, 11 and 13 call
-- crm_contact_backfill_pending).
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1-3. Tables
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_backfill_runs (
  id_prefix TEXT PRIMARY KEY,
  cutoff_at TIMESTAMPTZ NOT NULL,
  phone_allowlist TEXT NOT NULL DEFAULT '',
  test_phones TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_crm_backfill_runs_prefix CHECK (id_prefix ~ '^[a-z0-9]{1,16}$')
);

CREATE TABLE IF NOT EXISTS crm_contact_backfills (
  contact_id BIGINT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  id_prefix TEXT NOT NULL REFERENCES crm_backfill_runs(id_prefix) ON DELETE CASCADE,
  status TEXT NOT NULL,
  previous_crm_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (contact_id, id_prefix),
  CONSTRAINT chk_crm_contact_backfills_status CHECK (status IN ('pending', 'completed', 'skipped')),
  CONSTRAINT chk_crm_contact_backfills_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_crm_contact_backfills_pending
ON crm_contact_backfills (id_prefix, contact_id)
WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS crm_backfill_blocks (
  id_prefix TEXT NOT NULL REFERENCES crm_backfill_runs(id_prefix) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id_prefix, kind, entity_id),
  CONSTRAINT chk_crm_backfill_blocks_kind CHECK (kind IN ('lead', 'handoff', 'message', 'holder'))
);

-- -----------------------------------------------------------------------------
-- 4. Rules
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_contact_backfill_pending(p_contact_id BIGINT, p_id_prefix TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crm_contact_backfills b
    WHERE b.contact_id = p_contact_id
      AND b.status = 'pending'
      AND (p_id_prefix IS NULL OR b.id_prefix = p_id_prefix)
  )
$$;

-- S11: concretada = won; no concretada / cerrada = lost (closed when the
-- status was reached, else at the last activity); no other status: open only
-- while created at most 30 days before the cutoff, else lost at the last
-- activity. Statuses compare trimmed, case-insensitive, inner spaces folded.
CREATE OR REPLACE FUNCTION crm_backfill_lead_outcome(
  p_clickup_status TEXT,
  p_clickup_status_at TIMESTAMPTZ,
  p_created_at TIMESTAMPTZ,
  p_last_activity_at TIMESTAMPTZ,
  p_cutoff_at TIMESTAMPTZ
)
RETURNS TABLE (outcome TEXT, closed_at TIMESTAMPTZ)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN s.status_outcome IS NOT NULL THEN s.status_outcome
      WHEN p_created_at >= p_cutoff_at - INTERVAL '30 days' THEN 'open'
      ELSE 'lost'
    END,
    CASE
      WHEN s.status_outcome IS NOT NULL THEN COALESCE(p_clickup_status_at, p_last_activity_at, p_created_at)
      WHEN p_created_at >= p_cutoff_at - INTERVAL '30 days' THEN NULL
      -- An age-cutoff loss is decided at the cutoff, so it closes no later.
      ELSE LEAST(COALESCE(p_last_activity_at, p_created_at), p_cutoff_at)
    END
  FROM (
    SELECT CASE lower(regexp_replace(btrim(COALESCE(p_clickup_status, '')), '\s+', ' ', 'g'))
      WHEN 'concretada' THEN 'won'
      WHEN 'no concretada' THEN 'lost'
      WHEN 'cerrada' THEN 'lost'
    END AS status_outcome
  ) s
$$;

-- The lead's last activity: its newest message (its own conversations), else
-- its creation. leads.updated_at is not used: the dispatcher itself writes
-- the lead row.
CREATE OR REPLACE FUNCTION crm_lead_last_activity_at(p_lead_id BIGINT)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(
    l.created_at,
    (
      SELECT MAX(m.created_at)
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
      WHERE (c.lead_id = l.id OR c.id = l.source_conversation_id)
    )
  )
  FROM leads l
  WHERE l.id = p_lead_id
$$;

-- -----------------------------------------------------------------------------
-- 5. Start and abandon (operator, through scripts/ops/crm-backfill-1-3.sh)
-- -----------------------------------------------------------------------------
-- p_allowlist / p_test_phones: comma-separated digits ('' = none), the
-- dispatcher's CRM_EVENTS_PHONE_ALLOWLIST and LEAD_TEST_PHONE_NUMBERS.
-- Idempotent: a prefix that already has a run answers already_started and
-- changes nothing. A prefix with any crm_events row is refused (the live
-- dispatcher already sent under it, so history could no longer come first).
CREATE OR REPLACE FUNCTION crm_backfill_start(
  p_id_prefix TEXT,
  p_allowlist TEXT,
  p_test_phones TEXT,
  p_cutoff_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (result TEXT, cutoff_at TIMESTAMPTZ, pending_contacts INTEGER, skipped_contacts INTEGER)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_allow TEXT[] := string_to_array(NULLIF(regexp_replace(COALESCE(p_allowlist, ''), '[^0-9,]', '', 'g'), ''), ',');
  v_test TEXT[] := string_to_array(NULLIF(regexp_replace(COALESCE(p_test_phones, ''), '[^0-9,]', '', 'g'), ''), ',');
  v_run crm_backfill_runs%ROWTYPE;
BEGIN
  IF p_id_prefix IS NULL OR p_id_prefix !~ '^[a-z0-9]{1,16}$' THEN
    RAISE EXCEPTION 'crm_backfill_invalid_prefix: %', p_id_prefix;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-backfill-start', 0));

  SELECT r.* INTO v_run FROM crm_backfill_runs r WHERE r.id_prefix = p_id_prefix;
  IF FOUND THEN
    RETURN QUERY
    SELECT 'already_started'::TEXT, v_run.cutoff_at,
      (SELECT COUNT(*)::INTEGER FROM crm_contact_backfills b WHERE b.id_prefix = p_id_prefix AND b.status IN ('pending', 'completed')),
      (SELECT COUNT(*)::INTEGER FROM crm_contact_backfills b WHERE b.id_prefix = p_id_prefix AND b.status = 'skipped');
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM crm_events e WHERE e.id_prefix = p_id_prefix) THEN
    RAISE EXCEPTION 'crm_backfill_prefix_in_use: prefix % already has crm_events rows', p_id_prefix;
  END IF;

  INSERT INTO crm_backfill_runs (id_prefix, cutoff_at, phone_allowlist, test_phones)
  VALUES (p_id_prefix, p_cutoff_at, array_to_string(COALESCE(v_allow, '{}'), ','), array_to_string(COALESCE(v_test, '{}'), ','))
  RETURNING * INTO v_run;

  INSERT INTO crm_contact_backfills (contact_id, id_prefix, status, previous_crm_ids)
  SELECT ct.id, p_id_prefix,
    CASE WHEN regexp_replace(ct.phone_number, '\D', '', 'g') = ANY (COALESCE(v_test, '{}')) THEN 'skipped' ELSE 'pending' END,
    jsonb_strip_nulls(jsonb_build_object(
      'leads', (
        SELECT jsonb_agg(jsonb_build_object('id', l.id, 'crm_customer_id', l.crm_customer_id, 'crm_opportunity_id', l.crm_opportunity_id) ORDER BY l.id)
        FROM leads l
        WHERE l.source_number_id = ct.source_number_id AND l.phone_number = ct.phone_number
          AND (l.crm_customer_id IS NOT NULL OR l.crm_opportunity_id IS NOT NULL)
      ),
      'handoffs', (
        SELECT jsonb_agg(jsonb_build_object('id', h.id, 'crm_opportunity_id', h.crm_opportunity_id) ORDER BY h.id)
        FROM handoffs h
        LEFT JOIN conversations hc ON hc.id = h.conversation_id
        WHERE COALESCE(h.source_number_id, hc.source_number_id) = ct.source_number_id AND h.phone_number = ct.phone_number
          AND h.estado IN ('pending', 'notified', 'acknowledged') AND h.crm_opportunity_id IS NOT NULL
      ),
      'contact', CASE WHEN ct.crm_opportunity_id IS NOT NULL THEN jsonb_build_object(
        'crm_opportunity_id', ct.crm_opportunity_id, 'crm_opportunity_seller_id', ct.crm_opportunity_seller_id,
        'crm_opportunity_linked_at', ct.crm_opportunity_linked_at) END
    ))
  FROM crm_contacts ct
  WHERE v_allow IS NULL OR ct.phone_number = ANY (v_allow)
  ORDER BY ct.id;

  -- Prefix scoping (header 5): clear what the archive above holds.
  UPDATE leads l
  SET crm_customer_id = NULL, crm_opportunity_id = NULL
  FROM crm_contact_backfills b, jsonb_array_elements(b.previous_crm_ids -> 'leads') item
  WHERE b.id_prefix = p_id_prefix AND l.id = (item ->> 'id')::BIGINT;

  UPDATE handoffs h
  SET crm_opportunity_id = NULL
  FROM crm_contact_backfills b, jsonb_array_elements(b.previous_crm_ids -> 'handoffs') item
  WHERE b.id_prefix = p_id_prefix AND h.id = (item ->> 'id')::BIGINT;

  UPDATE crm_contacts ct
  SET crm_opportunity_id = NULL, crm_opportunity_seller_id = NULL, crm_opportunity_linked_at = NULL
  FROM crm_contact_backfills b
  WHERE b.id_prefix = p_id_prefix AND b.contact_id = ct.id AND b.previous_crm_ids ? 'contact';

  RETURN QUERY
  SELECT 'started'::TEXT, v_run.cutoff_at,
    (SELECT COUNT(*)::INTEGER FROM crm_contact_backfills b WHERE b.id_prefix = p_id_prefix AND b.status = 'pending'),
    (SELECT COUNT(*)::INTEGER FROM crm_contact_backfills b WHERE b.id_prefix = p_id_prefix AND b.status = 'skipped');
END;
$$;

-- Restores the archived CRM ids of the prefix's contacts and removes its run
-- (its contact rows and blocks cascade); the live stages stop waiting. The
-- crm_events rows stay (immutable history). For a rollback to the previous
-- prefix only; never part of the ordinary flow.
CREATE OR REPLACE FUNCTION crm_backfill_abandon(p_id_prefix TEXT)
RETURNS TABLE (restored_contacts INTEGER)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-backfill-start', 0));
  UPDATE leads l
  SET crm_customer_id = (item ->> 'crm_customer_id')::UUID, crm_opportunity_id = (item ->> 'crm_opportunity_id')::UUID
  FROM crm_contact_backfills b, jsonb_array_elements(b.previous_crm_ids -> 'leads') item
  WHERE b.id_prefix = p_id_prefix AND l.id = (item ->> 'id')::BIGINT;

  UPDATE handoffs h
  SET crm_opportunity_id = (item ->> 'crm_opportunity_id')::UUID, crm_routing_seller_id = NULL
  FROM crm_contact_backfills b, jsonb_array_elements(b.previous_crm_ids -> 'handoffs') item
  WHERE b.id_prefix = p_id_prefix AND h.id = (item ->> 'id')::BIGINT;

  UPDATE crm_contacts ct
  SET crm_opportunity_id = (b.previous_crm_ids #>> '{contact,crm_opportunity_id}')::UUID,
      crm_opportunity_seller_id = (b.previous_crm_ids #>> '{contact,crm_opportunity_seller_id}')::BIGINT,
      crm_opportunity_linked_at = (b.previous_crm_ids #>> '{contact,crm_opportunity_linked_at}')::TIMESTAMPTZ
  FROM crm_contact_backfills b
  WHERE b.id_prefix = p_id_prefix AND b.contact_id = ct.id AND b.previous_crm_ids ? 'contact';

  SELECT COUNT(*)::INTEGER INTO v_count FROM crm_contact_backfills b WHERE b.id_prefix = p_id_prefix;
  DELETE FROM crm_backfill_runs r WHERE r.id_prefix = p_id_prefix;
  RETURN QUERY SELECT v_count;
END;
$$;

COMMIT;
