-- Rollback of migration 034 (inbound debounce batches). Restores the exact 007
-- claim_inbound_event and 3-argument recover_and_claim_inbound_events bodies,
-- removes the batch trigger, the helper and the batch_leader_event_id column.
--
-- Before running it: set INBOUND_DEBOUNCE_SECONDS=0 (or import the pre-034
-- workflows) and let the contact queues drain. It refuses to run while a batch
-- is still in flight, because releasing its followers would answer messages
-- the batch turn already answered. Finished batches lose only their link.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -1 -f <this file>.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM inbound_events
    WHERE batch_leader_event_id IS NOT NULL
      AND processing_status IN ('received', 'processing')
  ) THEN
    RAISE EXCEPTION 'refusing to roll back 034: an in-flight inbound batch exists; set INBOUND_DEBOUNCE_SECONDS=0 and let the queues drain first';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS finish_inbound_event_batch_followers ON inbound_events;
DROP FUNCTION IF EXISTS finish_inbound_event_batch_followers();
DROP FUNCTION IF EXISTS recover_and_claim_inbound_events(INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS recover_and_claim_inbound_events(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BIGINT);
DROP FUNCTION IF EXISTS claim_inbound_event(JSONB);
DROP FUNCTION IF EXISTS inbound_payload_is_batchable(JSONB);

-- Verbatim from migration 007.
CREATE FUNCTION claim_inbound_event(p_payload JSONB)
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

DROP INDEX IF EXISTS idx_inbound_events_batch_leader;
ALTER TABLE inbound_events DROP COLUMN IF EXISTS batch_leader_event_id;
