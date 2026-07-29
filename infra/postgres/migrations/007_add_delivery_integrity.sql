-- Durable ingress, request identity and re-entrant external effects.
-- This migration is intentionally idempotent so it can be reapplied safely.

ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS instance_name TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_numbers_instance_name
ON whatsapp_numbers (instance_name)
WHERE instance_name IS NOT NULL AND deleted_at IS NULL;

-- Legacy rows can be attributed only when there is exactly one active business
-- number. With multiple active numbers there is no safe fact to infer.
WITH sole_active_number AS (
  SELECT MIN(id) AS id
  FROM whatsapp_numbers
  WHERE deleted_at IS NULL AND is_active = TRUE
  HAVING COUNT(*) = 1
),
updated_conversations AS (
  UPDATE conversations c
  SET source_number_id = san.id, updated_at = NOW()
  FROM sole_active_number san
  WHERE c.source_number_id IS NULL
    AND c.deleted_at IS NULL
  RETURNING c.id, san.id AS source_number_id
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
)
SELECT
  'source_number_backfilled', 'conversation', uc.id, 'system',
  'migration_007', 'success',
  jsonb_build_object('source_number_id', uc.source_number_id, 'rule', 'sole_active_number')
FROM updated_conversations uc;

WITH sole_active_number AS (
  SELECT MIN(id) AS id
  FROM whatsapp_numbers
  WHERE deleted_at IS NULL AND is_active = TRUE
  HAVING COUNT(*) = 1
),
updated_leads AS (
  UPDATE leads l
  SET source_number_id = san.id, updated_at = NOW()
  FROM sole_active_number san
  WHERE l.source_number_id IS NULL
    AND l.deleted_at IS NULL
  RETURNING l.id, san.id AS source_number_id
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
)
SELECT
  'source_number_backfilled', 'lead', ul.id, 'system',
  'migration_007', 'success',
  jsonb_build_object('source_number_id', ul.source_number_id, 'rule', 'sole_active_number')
FROM updated_leads ul;

CREATE TABLE IF NOT EXISTS inbound_events (
  id BIGSERIAL PRIMARY KEY,
  instance_name TEXT NOT NULL,
  external_message_id TEXT,
  event_fingerprint TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  source_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  phone_number TEXT,
  queue_key TEXT,
  event_type TEXT,
  normalized_event TEXT,
  should_process BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processing_token TEXT,
  processing_phase TEXT NOT NULL DEFAULT 'queued'
    CHECK (processing_phase IN ('queued', 'orchestrating', 'state_persisted', 'dispatching', 'completed')),
  normalized_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  downstream_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instance_name, dedupe_key)
);

ALTER TABLE inbound_events
  ADD COLUMN IF NOT EXISTS queue_key TEXT,
  ADD COLUMN IF NOT EXISTS processing_token TEXT,
  ADD COLUMN IF NOT EXISTS processing_phase TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS normalized_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS downstream_payload JSONB NOT NULL DEFAULT '{}'::JSONB;

UPDATE inbound_events
SET queue_key = source_number_id::text || ':' || phone_number
WHERE queue_key IS NULL
  AND source_number_id IS NOT NULL
  AND phone_number IS NOT NULL;

WITH duplicate_processing AS (
  SELECT id,
    row_number() OVER (PARTITION BY queue_key ORDER BY processing_started_at, received_at, id) AS position
  FROM inbound_events
  WHERE queue_key IS NOT NULL AND processing_status = 'processing'
)
UPDATE inbound_events ie
SET processing_status = 'received',
    processing_started_at = NULL,
    processing_token = NULL,
    failure_reason = 'migration_requeued_duplicate_processing'
FROM duplicate_processing dp
WHERE ie.id = dp.id AND dp.position > 1;

CREATE INDEX IF NOT EXISTS idx_inbound_events_processing_status
ON inbound_events (processing_status, received_at);

CREATE INDEX IF NOT EXISTS idx_inbound_events_queue_fifo
ON inbound_events (queue_key, received_at, id)
WHERE should_process = TRUE AND processing_status IN ('received', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_events_processing_queue
ON inbound_events (queue_key)
WHERE queue_key IS NOT NULL AND processing_status = 'processing';

CREATE INDEX IF NOT EXISTS idx_inbound_events_external_message
ON inbound_events (instance_name, external_message_id)
WHERE external_message_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_inbound_events_updated_at ON inbound_events;

CREATE TRIGGER set_inbound_events_updated_at
BEFORE UPDATE ON inbound_events
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION claim_inbound_event(p_payload JSONB)
RETURNS TABLE (
  inbound_event_id BIGINT,
  processing_token TEXT,
  duplicate_event BOOLEAN,
  should_process BOOLEAN,
  event_type TEXT,
  normalized_event TEXT,
  instance_name TEXT,
  phone_number TEXT,
  source_number_id BIGINT,
  whatsapp_name TEXT,
  external_contact_id TEXT,
  external_message_id TEXT,
  external_timestamp TEXT,
  message_type TEXT,
  text_body TEXT,
  raw_payload_json TEXT,
  attachment_type TEXT,
  mime_type TEXT,
  filename TEXT,
  external_media_id TEXT,
  external_url TEXT,
  sha256 TEXT,
  file_size TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_instance_name TEXT := COALESCE(NULLIF(p_payload->>'instance_name', ''), 'unknown');
  v_external_message_id TEXT := NULLIF(p_payload->>'external_message_id', '');
  v_phone_number TEXT := NULLIF(p_payload->>'phone_number', '');
  v_source_number_id BIGINT;
  v_event_fingerprint TEXT;
  v_dedupe_key TEXT;
  v_queue_key TEXT;
  v_requested_processing BOOLEAN := COALESCE((p_payload->>'requested_processing')::boolean, FALSE);
  v_status TEXT;
  v_failure_reason TEXT;
  v_token TEXT;
  v_event inbound_events%ROWTYPE;
BEGIN
  SELECT wn.id INTO v_source_number_id
  FROM whatsapp_numbers wn
  WHERE wn.deleted_at IS NULL
    AND wn.is_active = TRUE
    AND wn.instance_name = v_instance_name
  ORDER BY wn.id
  LIMIT 1;

  v_event_fingerprint := md5(concat_ws('|',
    v_instance_name,
    COALESCE(v_phone_number, ''),
    COALESCE(p_payload->>'external_timestamp', ''),
    COALESCE(NULLIF(p_payload->>'message_type', ''), 'unknown'),
    COALESCE(p_payload->>'text_body', ''),
    COALESCE(p_payload->>'raw_payload_json', '{}')
  ));
  v_dedupe_key := COALESCE('id:' || v_external_message_id, 'fp:' || v_event_fingerprint);
  v_queue_key := CASE
    WHEN v_source_number_id IS NOT NULL AND v_phone_number IS NOT NULL
      THEN v_source_number_id::text || ':' || v_phone_number
  END;

  -- The lock is acquired before any queue read. Calls waiting on the same
  -- source+phone resume with a fresh READ COMMITTED snapshot inside PL/pgSQL.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    COALESCE(v_queue_key, 'unmapped:' || v_instance_name || ':' || COALESCE(v_phone_number, '')),
    0
  ));

  SELECT ie.* INTO v_event
  FROM inbound_events ie
  WHERE ie.instance_name = v_instance_name
    AND ie.dedupe_key = v_dedupe_key;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_event.id, v_event.processing_token, TRUE, FALSE,
      p_payload->>'event_type', p_payload->>'normalized_event', v_instance_name,
      v_phone_number, v_event.source_number_id, p_payload->>'whatsapp_name',
      p_payload->>'external_contact_id', v_external_message_id,
      p_payload->>'external_timestamp',
      COALESCE(NULLIF(p_payload->>'message_type', ''), 'unknown'),
      p_payload->>'text_body', COALESCE(p_payload->>'raw_payload_json', '{}'),
      p_payload->>'attachment_type', p_payload->>'mime_type', p_payload->>'filename',
      p_payload->>'external_media_id', p_payload->>'external_url',
      p_payload->>'sha256', p_payload->>'file_size';
    RETURN;
  END IF;

  IF v_requested_processing AND v_source_number_id IS NULL THEN
    v_status := 'failed';
    v_failure_reason := 'unknown_instance';
  ELSIF v_requested_processing AND v_phone_number IS NULL THEN
    v_status := 'failed';
    v_failure_reason := 'missing_phone_number';
  ELSIF NOT v_requested_processing THEN
    v_status := 'ignored';
  ELSIF EXISTS (
    SELECT 1 FROM inbound_events queued
    WHERE queued.queue_key = v_queue_key
      AND queued.processing_status IN ('received', 'processing')
  ) THEN
    v_status := 'received';
  ELSE
    v_status := 'processing';
    v_token := md5(random()::text || clock_timestamp()::text || v_dedupe_key);
  END IF;

  INSERT INTO inbound_events (
    instance_name, external_message_id, event_fingerprint, dedupe_key,
    source_number_id, phone_number, queue_key, event_type, normalized_event,
    should_process, processing_status, processing_started_at, processing_token,
    processing_phase, attempt_count, failure_reason, raw_payload, normalized_payload
  )
  VALUES (
    v_instance_name, v_external_message_id, v_event_fingerprint, v_dedupe_key,
    v_source_number_id, v_phone_number, v_queue_key, p_payload->>'event_type',
    p_payload->>'normalized_event',
    (v_requested_processing AND v_source_number_id IS NOT NULL AND v_phone_number IS NOT NULL),
    v_status, CASE WHEN v_status = 'processing' THEN NOW() END, v_token,
    CASE WHEN v_status = 'processing' THEN 'orchestrating' ELSE 'queued' END,
    CASE WHEN v_status = 'processing' THEN 1 ELSE 0 END, v_failure_reason,
    COALESCE(NULLIF(p_payload->>'raw_payload_json', '')::jsonb, '{}'::jsonb),
    p_payload
  )
  RETURNING * INTO v_event;

  RETURN QUERY SELECT
    v_event.id, v_event.processing_token, FALSE, (v_status = 'processing'),
    p_payload->>'event_type', p_payload->>'normalized_event', v_instance_name,
    v_phone_number, v_source_number_id, p_payload->>'whatsapp_name',
    p_payload->>'external_contact_id', v_external_message_id,
    p_payload->>'external_timestamp',
    COALESCE(NULLIF(p_payload->>'message_type', ''), 'unknown'),
    p_payload->>'text_body', COALESCE(p_payload->>'raw_payload_json', '{}'),
    p_payload->>'attachment_type', p_payload->>'mime_type', p_payload->>'filename',
    p_payload->>'external_media_id', p_payload->>'external_url',
    p_payload->>'sha256', p_payload->>'file_size';
END;
$$;

DROP FUNCTION IF EXISTS recover_and_claim_inbound_events(INTEGER, INTEGER, INTEGER);

CREATE FUNCTION recover_and_claim_inbound_events(
  p_stale_seconds INTEGER,
  p_batch_size INTEGER,
  p_max_attempts INTEGER
)
RETURNS TABLE (
  inbound_event_id BIGINT,
  processing_token TEXT,
  source_number_id BIGINT,
  normalized_payload JSONB,
  downstream_payload JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_stale_seconds INTEGER := GREATEST(60, p_stale_seconds);
  v_batch_size INTEGER := GREATEST(1, LEAST(100, p_batch_size));
  v_max_attempts INTEGER := GREATEST(1, p_max_attempts);
BEGIN
  UPDATE inbound_events ie
  SET processing_status = 'failed',
      failed_at = NOW(),
      processing_token = NULL,
      failure_reason = 'stale_processing_max_attempts',
      updated_at = NOW()
  WHERE ie.processing_status = 'processing'
    AND ie.processing_started_at < NOW() - make_interval(secs => v_stale_seconds)
    AND ie.attempt_count >= v_max_attempts
    ;

  UPDATE inbound_events ie
  SET processing_status = 'received',
      processing_started_at = NULL,
      processing_token = NULL,
      failure_reason = 'stale_processing_requeued',
      updated_at = NOW()
  WHERE ie.processing_status = 'processing'
    AND ie.processing_started_at < NOW() - make_interval(secs => v_stale_seconds)
    AND ie.attempt_count < v_max_attempts
    ;

  RETURN QUERY
  WITH ranked AS (
    SELECT ie.id,
      row_number() OVER (
        PARTITION BY ie.queue_key ORDER BY ie.received_at, ie.id
      ) AS queue_position
    FROM inbound_events ie
    WHERE ie.should_process = TRUE
      AND ie.processing_status = 'received'
      AND ie.queue_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM inbound_events active
        WHERE active.queue_key = ie.queue_key
          AND active.processing_status = 'processing'
      )
  ),
  selected AS (
    SELECT ie.id
    FROM inbound_events ie
    JOIN ranked r ON r.id = ie.id AND r.queue_position = 1
    ORDER BY ie.received_at, ie.id
    FOR UPDATE OF ie SKIP LOCKED
    LIMIT v_batch_size
  ),
  claimed AS (
    UPDATE inbound_events ie
    SET processing_status = 'processing',
        processing_started_at = NOW(),
        processing_token = md5(random()::text || clock_timestamp()::text || ie.id::text),
        processing_phase = CASE
          WHEN ie.downstream_payload <> '{}'::jsonb THEN 'dispatching'
          ELSE 'orchestrating'
        END,
        attempt_count = ie.attempt_count + 1,
        failure_reason = NULL,
        updated_at = NOW()
    FROM selected s
    WHERE ie.id = s.id
      AND ie.processing_status = 'received'
    RETURNING ie.id, ie.processing_token, ie.source_number_id, ie.normalized_payload, ie.downstream_payload
  )
  SELECT c.id, c.processing_token, c.source_number_id, c.normalized_payload, c.downstream_payload
  FROM claimed c
  ORDER BY c.id;
END;
$$;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS inbound_event_id BIGINT REFERENCES inbound_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_phase TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_token TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_inbound_event
ON messages (inbound_event_id)
WHERE inbound_event_id IS NOT NULL AND direction = 'incoming' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_outgoing_idempotency_key
ON messages (idempotency_key)
WHERE direction = 'outgoing' AND idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_outbound_reconciliation
ON messages (updated_at)
WHERE direction = 'outgoing' AND reconciliation_required = TRUE;

CREATE OR REPLACE FUNCTION claim_outbound_message(
  p_conversation_id BIGINT,
  p_lead_id BIGINT,
  p_message_type TEXT,
  p_text_body TEXT,
  p_raw_payload JSONB,
  p_response_kind TEXT,
  p_provider_instance_name TEXT,
  p_idempotency_key TEXT,
  p_claim_stale_seconds INTEGER
)
RETURNS TABLE (
  id BIGINT,
  conversation_id BIGINT,
  lead_id BIGINT,
  message_type TEXT,
  delivery_status TEXT,
  text_body TEXT,
  raw_payload JSONB,
  instance_name TEXT,
  idempotency_key TEXT,
  phone_number TEXT,
  outbound_body JSONB,
  already_sent BOOLEAN,
  should_send BOOLEAN,
  external_message_id TEXT,
  response_kind TEXT,
  dispatch_token TEXT,
  dispatch_phase TEXT,
  reconciliation_required BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_message messages%ROWTYPE;
  v_token TEXT;
  v_stale_seconds INTEGER := GREATEST(30, p_claim_stale_seconds);
  v_should_send BOOLEAN := FALSE;
BEGIN
  IF p_idempotency_key IS NULL OR p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Outbound operation requires conversation_id and idempotency_key';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('outbound:' || p_idempotency_key, 0));

  SELECT m.* INTO v_message
  FROM messages m
  WHERE m.direction = 'outgoing'
    AND m.deleted_at IS NULL
    AND m.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    v_token := md5(random()::text || clock_timestamp()::text || p_idempotency_key);
    INSERT INTO messages (
      conversation_id, lead_id, direction, message_type, delivery_status,
      text_body, raw_payload, provider_instance_name, idempotency_key,
      dispatch_phase, dispatch_token, claimed_at
    )
    VALUES (
      p_conversation_id, p_lead_id, 'outgoing', COALESCE(p_message_type, 'text'),
      'queued', p_text_body, COALESCE(p_raw_payload, '{}'::jsonb),
      p_provider_instance_name, p_idempotency_key, 'claimed', v_token, NOW()
    )
    RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.delivery_status = 'sent' OR v_message.dispatch_phase = 'sent' THEN
    v_should_send := FALSE;
  ELSIF v_message.dispatch_phase = 'claimed'
    AND COALESCE(v_message.claimed_at, v_message.updated_at) <
      NOW() - make_interval(secs => v_stale_seconds) THEN
    v_token := md5(random()::text || clock_timestamp()::text || p_idempotency_key);
    UPDATE messages m
    SET dispatch_token = v_token,
        claimed_at = NOW(),
        reconciliation_required = FALSE,
        reconciliation_reason = NULL,
        updated_at = NOW()
    WHERE m.id = v_message.id
    RETURNING * INTO v_message;
    v_should_send := TRUE;
  ELSIF v_message.dispatch_phase = 'sending'
    AND COALESCE(v_message.attempt_started_at, v_message.updated_at) <
      NOW() - make_interval(secs => v_stale_seconds) THEN
    UPDATE messages m
    SET delivery_status = 'unknown',
        dispatch_phase = 'unknown',
        reconciliation_required = TRUE,
        reconciliation_reason = 'stale_sending_outcome_ambiguous',
        updated_at = NOW()
    WHERE m.id = v_message.id
    RETURNING * INTO v_message;
    v_should_send := FALSE;
  END IF;

  RETURN QUERY SELECT
    v_message.id, v_message.conversation_id, v_message.lead_id,
    v_message.message_type, v_message.delivery_status, v_message.text_body,
    v_message.raw_payload, v_message.provider_instance_name,
    v_message.idempotency_key, v_message.raw_payload->>'number',
    v_message.raw_payload,
    (v_message.delivery_status = 'sent' OR v_message.dispatch_phase = 'sent'),
    v_should_send, v_message.external_message_id, p_response_kind,
    v_message.dispatch_token, v_message.dispatch_phase,
    v_message.reconciliation_required;
END;
$$;

-- Evolution emits stickers as their own media type. The original schema
-- rejected them even though the normalizer already produced `sticker`.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_message_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_message_type_check CHECK (
    message_type IN (
      'text', 'image', 'audio', 'document', 'video', 'sticker',
      'location', 'interactive', 'unknown'
    )
  );

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL;

UPDATE leads l
SET source_conversation_id = candidate.conversation_id
FROM (
  SELECT DISTINCT ON (c.lead_id)
    c.lead_id,
    c.id AS conversation_id
  FROM conversations c
  WHERE c.lead_id IS NOT NULL
    AND c.deleted_at IS NULL
  ORDER BY c.lead_id, c.started_at ASC, c.id ASC
) candidate
WHERE l.id = candidate.lead_id
  AND l.source_conversation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_source_conversation
ON leads (source_conversation_id)
WHERE source_conversation_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE lead_assignments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS rotation_applied_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_assignments_idempotency_key
ON lead_assignments (idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS external_operations (
  id BIGSERIAL PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  external_id TEXT,
  external_url TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  response_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_operations_status
ON external_operations (status, locked_at);

CREATE INDEX IF NOT EXISTS idx_external_operations_entity
ON external_operations (entity_type, entity_id);

DROP TRIGGER IF EXISTS set_external_operations_updated_at ON external_operations;

CREATE TRIGGER set_external_operations_updated_at
BEFORE UPDATE ON external_operations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- POST operations can have an ambiguous outcome when the provider times out or
-- returns a server error after accepting the request. Those operations require
-- reconciliation and must never be claimed automatically again.
ALTER TABLE external_operations
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT,
  ADD COLUMN IF NOT EXISTS retry_safe BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE external_operations
  DROP CONSTRAINT IF EXISTS external_operations_status_check;
ALTER TABLE external_operations
  ADD CONSTRAINT external_operations_status_check
  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_external_operations_reconciliation
ON external_operations (updated_at)
WHERE reconciliation_required = TRUE;
