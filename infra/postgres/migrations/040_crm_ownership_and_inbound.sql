-- CRM revision 1.2b: ownership_version, bot -> CRM ownership events and the
-- CRM -> bot chat.take / chat.release webhook.
--
-- Owner decision (2026-11-11, option 1): the CRM path runs IN PARALLEL with the
-- ClickUp path. No ClickUp query or workflow changes; everything here is
-- additive except one relaxed constraint, explained below.
--
-- 1. lead_chat_ownerships (shared with ClickUp):
--    * clickup_task_id DROP NOT NULL. A chat taken from the CRM has no ClickUp
--      task, and inventing one would make the ClickUp lease scheduler PUT a
--      task that does not belong to that take. With NULL task id and NULL
--      previous_clickup_status the existing ClickUp SQL already does the safe
--      thing: SLA expiry (06) releases the row and queues no ClickUp restore
--      ('skipped_no_previous_status'), and a late seller reply (04) reacquires
--      it while 09 skips the ClickUp reacquisition ('clickup_task_id_missing').
--      Without this change 04 would fail with a NOT NULL violation when it
--      reacquires after a CRM-held row. The CHECK (clickup_task_id <> '') stays,
--      so ClickUp rows keep a real task id. Every ClickUp query writes a task id
--      as before (integration suites lead-chat-ownership, lead-chat-quote-
--      followup and crm-ownership-1-2b prove it).
--    * acquired_via / released_via ('crm' or NULL) mark CRM-driven changes;
--      owner_seller_id is the seller who took the chat from the CRM (ClickUp
--      rows keep NULL: their owner is the lead's assigned seller).
-- 2. crm_conversation_ownership: one row per conversation with the monotonic
--    ownership_version and the last change. crm_ownership_changes: one row per
--    version, the outbox source of ownership.taken / ownership.released.
--    A trigger on lead_chat_ownerships advances the version on every
--    acquisition (INSERT of a live row) and every release (released_at set),
--    whatever wrote it: ClickUp, the CRM, the SLA sweeper, the orchestrator.
--    The trigger never fails the write that fired it.
-- 3. crm_events accepts ownership.taken / ownership.released rows, identified
--    by ownership_change_id (lead_id NULL, revision 1, like message.new).
-- 4. crm_inbound_events: idempotency inbox of the CRM webhook, keyed by
--    event_id, with the sha256 of the raw body and the stored response.
-- 5. crm_inbound_apply_chat_event(): the whole chat.take / chat.release
--    decision in one transaction (a function, so the response can report the
--    version the trigger wrote in the same transaction).

-- -----------------------------------------------------------------------------
-- 1. lead_chat_ownerships
-- -----------------------------------------------------------------------------
ALTER TABLE lead_chat_ownerships ALTER COLUMN clickup_task_id DROP NOT NULL;

ALTER TABLE lead_chat_ownerships
  ADD COLUMN IF NOT EXISTS acquired_via TEXT,
  ADD COLUMN IF NOT EXISTS released_via TEXT,
  ADD COLUMN IF NOT EXISTS owner_seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lead_chat_ownerships_acquired_via') THEN
    ALTER TABLE lead_chat_ownerships
      ADD CONSTRAINT chk_lead_chat_ownerships_acquired_via CHECK (acquired_via IS NULL OR acquired_via = 'crm');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lead_chat_ownerships_released_via') THEN
    ALTER TABLE lead_chat_ownerships
      ADD CONSTRAINT chk_lead_chat_ownerships_released_via CHECK (released_via IS NULL OR released_via = 'crm');
  END IF;
END
$$;

-- The conversation a lead is announced under: the same expression the
-- lead.qualified stage uses (01_select_lead_qualified_candidates.sql).
CREATE OR REPLACE FUNCTION crm_lead_conversation_id(p_lead_id BIGINT)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    l.source_conversation_id,
    (
      SELECT c.id
      FROM conversations c
      WHERE c.lead_id = l.id
        AND c.deleted_at IS NULL
      ORDER BY c.id DESC
      LIMIT 1
    )
  )
  FROM leads l
  WHERE l.id = p_lead_id
$$;

-- -----------------------------------------------------------------------------
-- 2. Version and change history
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_conversation_ownership (
  conversation_id BIGINT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  ownership_version BIGINT NOT NULL DEFAULT 0,
  owner_kind TEXT NOT NULL DEFAULT 'bot',
  seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  source TEXT,
  reason TEXT,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  ownership_id BIGINT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_crm_conversation_ownership_version CHECK (ownership_version >= 0),
  CONSTRAINT chk_crm_conversation_ownership_owner CHECK (owner_kind IN ('bot', 'seller')),
  CONSTRAINT chk_crm_conversation_ownership_source CHECK (source IS NULL OR source IN ('clickup', 'crm', 'bot'))
);

CREATE TABLE IF NOT EXISTS crm_ownership_changes (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ownership_version BIGINT NOT NULL,
  change_kind TEXT NOT NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  ownership_id BIGINT,
  seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  -- CRM vocabulary: taken -> clickup | crm; released -> clickup | crm | bot.
  source TEXT NOT NULL,
  -- CRM release reason (NULL for taken); raw_reason is lead_chat_ownerships.
  -- release_reason as written, kept as evidence of the mapping.
  reason TEXT,
  raw_reason TEXT,
  crm_blocked_reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_ownership_changes_version_key UNIQUE (conversation_id, ownership_version),
  CONSTRAINT chk_crm_ownership_changes_kind CHECK (change_kind IN ('taken', 'released')),
  CONSTRAINT chk_crm_ownership_changes_source CHECK (source IN ('clickup', 'crm', 'bot')),
  CONSTRAINT chk_crm_ownership_changes_reason CHECK (
    (change_kind = 'taken' AND reason IS NULL)
    OR (change_kind = 'released'
        AND reason IN ('seller_released', 'sla_expired', 'customer_new_quote', 'opportunity_closed'))
  )
);

CREATE INDEX IF NOT EXISTS idx_crm_ownership_changes_changed_at
ON crm_ownership_changes (changed_at, id);

-- Advances the conversation's version for one acquisition or release. Runs
-- AFTER the ClickUp/CRM/SLA write and NEVER fails it: any error (no
-- conversation, a constraint, an unexpected value) is reported as a WARNING
-- and the tracking subtransaction is rolled back, the ownership write stays.
-- Unknown release reasons map to seller_released (raw_reason keeps the truth).
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
    v_conversation := crm_lead_conversation_id(NEW.lead_id);
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

DROP TRIGGER IF EXISTS trg_crm_track_ownership_acquired ON lead_chat_ownerships;
CREATE TRIGGER trg_crm_track_ownership_acquired
AFTER INSERT ON lead_chat_ownerships
FOR EACH ROW
WHEN (NEW.released_at IS NULL AND NEW.deleted_at IS NULL)
EXECUTE FUNCTION crm_track_lead_chat_ownership();

DROP TRIGGER IF EXISTS trg_crm_track_ownership_released ON lead_chat_ownerships;
CREATE TRIGGER trg_crm_track_ownership_released
AFTER UPDATE OF released_at ON lead_chat_ownerships
FOR EACH ROW
WHEN (OLD.released_at IS NULL AND NEW.released_at IS NOT NULL)
EXECUTE FUNCTION crm_track_lead_chat_ownership();

-- -----------------------------------------------------------------------------
-- 3. crm_events: ownership events
-- -----------------------------------------------------------------------------
ALTER TABLE crm_events
  ADD COLUMN IF NOT EXISTS ownership_change_id BIGINT REFERENCES crm_ownership_changes(id) ON DELETE RESTRICT;

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_identity_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_identity_check CHECK (
  (event_type <> 'lead.qualified' OR lead_id IS NOT NULL)
  AND (event_type <> 'message.new' OR message_id IS NOT NULL)
  AND (event_type NOT IN ('ownership.taken', 'ownership.released') OR ownership_change_id IS NOT NULL)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_event_type_check') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_event_type_check CHECK (
      event_type IN ('lead.qualified', 'message.new', 'ownership.taken', 'ownership.released')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_events_ownership_change_key') THEN
    ALTER TABLE crm_events ADD CONSTRAINT crm_events_ownership_change_key UNIQUE (ownership_change_id);
  END IF;
END
$$;

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
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.ownership_change_id IS DISTINCT FROM OLD.ownership_change_id THEN
    RAISE EXCEPTION 'crm_events % is immutable: body, event_id, event_type, revision, lead_id, message_id and ownership_change_id never change', OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Inbound idempotency inbox
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_inbound_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response JSONB NOT NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_crm_inbound_events_sha256 CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_crm_inbound_events_status CHECK (http_status BETWEEN 200 AND 599)
);

-- -----------------------------------------------------------------------------
-- 5. chat.take / chat.release
-- -----------------------------------------------------------------------------
-- Returns the HTTP status and JSON response for one verified event (the
-- signature, envelope and data shape are checked by the workflow first).
--   * Same event_id and same body sha256 -> the stored response (replayed).
--     Same event_id, different bytes -> 409 event_conflict (not stored).
--   * crm_opportunity_id -> newest live lead with leads.crm_opportunity_id
--     (422 invalid_opportunity); crm_seller_id -> live, active seller with
--     sellers.crm_user_id (422 invalid_seller).
--   * data.ownership_version lower than the conversation's version ->
--     200 ignored_stale with the current version, nothing changes.
--   * chat.take: a live lease of a different seller -> 409 ownership_conflict
--     with the holder's crm_user_id (NULL when unmapped). The same seller ->
--     200 applied, no new version. Otherwise the CRM acquires with the
--     semantics of 01_acquire_ownership_from_clickup.sql: the bot goes silent,
--     the newest customer message is the pending one and opens a 2-hour window
--     (no message, no deadline yet), sla_mode 'standard'. No ClickUp column is
--     written. A lease whose SLA already expired but was not swept yet is first
--     released as 'sla_expired', exactly as 06_claim_expired_ownerships.sql
--     would; its ClickUp restoration (ClickUp rows with a previous status) is
--     left 'pending' with an old claim time, so the lease sweeper's stale-claim
--     branch claims and performs it on its next tick.
--   * chat.release: only the holder releases (else 409). release_reason
--     'manual' + released_via 'crm', restoration 'not_required' (the ClickUp
--     task is not touched; ClickUp shows stale status during the parallel run).
--     A chat the bot already owns (or whose SLA expired) -> 200 ignored_stale.
-- Every change goes through the version trigger, so ownership.taken (source
-- crm) / ownership.released (seller_released) are echoed back to the CRM.
CREATE OR REPLACE FUNCTION crm_inbound_apply_chat_event(
  p_event_id TEXT,
  p_body_sha256 TEXT,
  p_event_type TEXT,
  p_opportunity_id UUID,
  p_seller_id UUID,
  p_ownership_version BIGINT
)
RETURNS TABLE (http_status INTEGER, response JSONB, replayed BOOLEAN)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_stored crm_inbound_events%ROWTYPE;
  v_lead leads%ROWTYPE;
  v_seller sellers%ROWTYPE;
  v_active lead_chat_ownerships%ROWTYPE;
  v_has_active BOOLEAN := FALSE;
  v_live BOOLEAN := FALSE;
  v_conversation BIGINT;
  v_current BIGINT;
  v_holder BIGINT;
  v_status INTEGER;
  v_response JSONB;
  v_message_id BIGINT;
  v_message_at TIMESTAMPTZ;
  v_new_id BIGINT;
BEGIN
  IF p_event_id IS NULL OR p_body_sha256 IS NULL OR p_event_type IS NULL
     OR p_event_type NOT IN ('chat.take', 'chat.release')
     OR p_ownership_version IS NULL OR p_ownership_version < 0 THEN
    RAISE EXCEPTION 'crm_inbound_apply_chat_event: invalid arguments';
  END IF;

  -- Concurrent deliveries of one event_id serialize here.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-inbound-event:' || p_event_id, 0));

  SELECT e.* INTO v_stored FROM crm_inbound_events e WHERE e.event_id = p_event_id;
  IF FOUND THEN
    IF v_stored.body_sha256 = p_body_sha256 THEN
      RETURN QUERY SELECT v_stored.http_status, v_stored.response, TRUE;
    ELSE
      RETURN QUERY SELECT 409, jsonb_build_object('error', 'event_conflict', 'event_id', p_event_id), FALSE;
    END IF;
    RETURN;
  END IF;

  SELECT l.* INTO v_lead
  FROM leads l
  WHERE l.crm_opportunity_id = p_opportunity_id
    AND l.deleted_at IS NULL
  ORDER BY l.id DESC
  LIMIT 1;
  IF FOUND THEN
    v_conversation := crm_lead_conversation_id(v_lead.id);
  END IF;

  IF v_lead.id IS NULL OR v_conversation IS NULL THEN
    v_status := 422;
    v_response := jsonb_build_object('error', 'invalid_opportunity', 'event_id', p_event_id);
  ELSE
    SELECT s.* INTO v_seller
    FROM sellers s
    WHERE s.crm_user_id = p_seller_id
      AND s.deleted_at IS NULL
      AND s.is_active
    LIMIT 1;

    IF v_seller.id IS NULL THEN
      v_status := 422;
      v_response := jsonb_build_object('error', 'invalid_seller', 'event_id', p_event_id);
    ELSE
      -- Same chat-authority lock as 04_register_human_reply.sql, so a CRM take
      -- and a seller's own WhatsApp reply never interleave.
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'chat-authority:' || v_lead.source_number_id::text || ':' || v_lead.phone_number, 0
      ));

      SELECT o.* INTO v_active
      FROM lead_chat_ownerships o
      WHERE o.lead_id = v_lead.id
        AND o.released_at IS NULL
        AND o.deleted_at IS NULL
      FOR UPDATE;
      v_has_active := FOUND;
      v_live := v_has_active AND (v_active.response_due_at IS NULL OR v_active.response_due_at > NOW());

      SELECT cco.ownership_version INTO v_current
      FROM crm_conversation_ownership cco
      WHERE cco.conversation_id = v_conversation
      FOR UPDATE;
      v_current := COALESCE(v_current, 0);

      IF v_live THEN
        v_holder := COALESCE(v_active.owner_seller_id, v_lead.assigned_seller_id);
      END IF;

      IF p_ownership_version < v_current THEN
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'ignored_stale', 'ownership_version', v_current);
      ELSIF v_live AND v_holder IS DISTINCT FROM v_seller.id THEN
        v_status := 409;
        v_response := jsonb_build_object(
          'error', 'ownership_conflict',
          'holder_crm_seller_id', (
            SELECT s.crm_user_id FROM sellers s WHERE s.id = v_holder AND s.deleted_at IS NULL
          ),
          'ownership_version', v_current
        );
      ELSIF p_event_type = 'chat.take' AND v_live THEN
        -- The requesting seller already holds the chat.
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied', 'ownership_version', v_current);
      ELSIF p_event_type = 'chat.take' THEN
        IF v_has_active THEN
          UPDATE lead_chat_ownerships o
          SET released_at = NOW(),
              release_reason = 'sla_expired',
              restoration_state = CASE
                WHEN o.acquired_via = 'crm' OR o.clickup_task_id IS NULL THEN 'not_required'
                WHEN o.previous_clickup_status IS NOT NULL THEN 'pending'
                ELSE 'skipped_no_previous_status'
              END,
              restoration_claimed_at = CASE
                WHEN o.acquired_via IS NULL AND o.clickup_task_id IS NOT NULL
                     AND o.previous_clickup_status IS NOT NULL
                  THEN TIMESTAMPTZ 'epoch'
                ELSE o.restoration_claimed_at
              END,
              restoration_error = CASE
                WHEN o.acquired_via IS NULL AND o.clickup_task_id IS NOT NULL
                     AND o.previous_clickup_status IS NULL
                  THEN 'previous_clickup_status_missing: '
                    || 'el lease vencio sin evidencia del estado previo de ClickUp; '
                    || 'la restauracion requiere intervencion manual'
                ELSE o.restoration_error
              END,
              updated_at = NOW()
          WHERE o.id = v_active.id;

          INSERT INTO audit_logs (
            event_name, entity_type, entity_id, actor_type, actor_id,
            result, before_payload, after_payload, metadata
          ) VALUES (
            'lead_chat_ownership_sla_expiry', 'lead_chat_ownership', v_active.id, 'system',
            'crm-inbound-events', 'expired_before_crm_take',
            jsonb_build_object('response_due_at', v_active.response_due_at),
            jsonb_build_object('release_reason', 'sla_expired'),
            jsonb_build_object('lead_id', v_lead.id, 'crm_event_id', p_event_id)
          );
        END IF;

        SELECT m.id, m.created_at INTO v_message_id, v_message_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.deleted_at IS NULL
          AND m.direction = 'incoming'
          AND m.sender_type = 'customer'
          AND (m.lead_id = v_lead.id OR c.lead_id = v_lead.id)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1;

        INSERT INTO lead_chat_ownerships (
          lead_id, clickup_task_id, previous_clickup_status, acquired_at,
          pending_message_id, pending_message_at, response_due_at,
          sla_mode, acquired_via, owner_seller_id
        ) VALUES (
          v_lead.id, NULL, NULL, NOW(),
          v_message_id, v_message_at,
          CASE WHEN v_message_id IS NOT NULL THEN NOW() + INTERVAL '2 hours' END,
          'standard', 'crm', v_seller.id
        )
        RETURNING id INTO v_new_id;

        INSERT INTO audit_logs (
          event_name, entity_type, entity_id, actor_type, actor_id,
          result, before_payload, after_payload, metadata
        ) VALUES (
          'lead_chat_ownership_acquisition', 'lead_chat_ownership', v_new_id, 'system',
          'crm-inbound-events', 'acquired',
          jsonb_build_object('ownership_id', v_active.id),
          jsonb_build_object('ownership_id', v_new_id, 'owner_seller_id', v_seller.id),
          jsonb_build_object('lead_id', v_lead.id, 'crm_event_id', p_event_id, 'crm_seller_id', p_seller_id)
        );

        SELECT cco.ownership_version INTO v_current
        FROM crm_conversation_ownership cco WHERE cco.conversation_id = v_conversation;
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied', 'ownership_version', COALESCE(v_current, 0));
      ELSIF v_live THEN
        -- chat.release by the holder.
        UPDATE lead_chat_ownerships o
        SET released_at = NOW(),
            release_reason = 'manual',
            released_via = 'crm',
            restoration_state = 'not_required',
            updated_at = NOW()
        WHERE o.id = v_active.id;

        INSERT INTO audit_logs (
          event_name, entity_type, entity_id, actor_type, actor_id,
          result, before_payload, after_payload, metadata
        ) VALUES (
          'lead_chat_ownership_release', 'lead_chat_ownership', v_active.id, 'system',
          'crm-inbound-events', 'released',
          jsonb_build_object('released_at', NULL),
          jsonb_build_object('release_reason', 'manual', 'released_via', 'crm'),
          jsonb_build_object('lead_id', v_lead.id, 'crm_event_id', p_event_id, 'crm_seller_id', p_seller_id)
        );

        SELECT cco.ownership_version INTO v_current
        FROM crm_conversation_ownership cco WHERE cco.conversation_id = v_conversation;
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'applied', 'ownership_version', COALESCE(v_current, 0));
      ELSE
        -- chat.release on a chat the bot already owns.
        v_status := 200;
        v_response := jsonb_build_object('event_id', p_event_id, 'result', 'ignored_stale', 'ownership_version', v_current);
      END IF;
    END IF;
  END IF;

  INSERT INTO crm_inbound_events (event_id, event_type, body_sha256, http_status, response, lead_id, conversation_id)
  VALUES (p_event_id, p_event_type, p_body_sha256, v_status, v_response, v_lead.id, v_conversation);

  RETURN QUERY SELECT v_status, v_response, FALSE;
END;
$$;
